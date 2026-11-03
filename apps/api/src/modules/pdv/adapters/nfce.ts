import { XMLParser } from 'fast-xml-parser';

/**
 * Adaptador de NFC-e (modelo 65) — leiaute oficial da NF-e/NFC-e (MOC 4.00, SEFAZ).
 * Não depende de nenhum fornecedor: lê o XML autorizado (nfeProc) e o XML do evento de cancelamento (procEventoNFe).
 *
 * Saída normalizada (independente do PDV) — o restante do sistema só conhece este formato.
 */

export interface NormalizedSaleItem {
  lineNo: number;
  code: string;
  ean: string | null;
  description: string;
  unit: string | null;
  quantity: string;   // até 3 casas
  unitPrice: string;  // até 4 casas
  gross: string;      // 2 casas
  discount: string;
  net: string;
}

export interface NormalizedPayment { nfceCode: string; amount: string; cardBrand: string | null }

export interface NormalizedSale {
  externalId: string;      // chave de acesso (44 dígitos)
  model: string;
  number: string;
  series: string;
  issuerDocument: string;
  environment: '1' | '2';  // 1 = produção, 2 = homologação
  authorized: boolean;
  authorizationStatus: string | null;
  soldAt: string;          // ISO 8601 com fuso
  gross: string;
  discount: string;
  other: string;
  net: string;
  operator: string | null;
  items: NormalizedSaleItem[];
  payments: NormalizedPayment[];
}

export type ParsedDocument =
  | { kind: 'venda'; sale: NormalizedSale }
  | { kind: 'cancelamento'; accessKey: string; at: string; reason: string | null; registered: boolean }
  | { kind: 'desconhecido'; error: string };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ['det', 'detPag'].includes(name),
});

type Node = Record<string, unknown>;
const obj = (v: unknown): Node => (v && typeof v === 'object' ? (v as Node) : {});
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** Normaliza decimal com ponto para no máximo `dec` casas, arredondando meio para cima (sem float). */
export function roundDecimal(v: string | null, dec: number): string {
  const s = (v ?? '0').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`valor numérico inválido: "${s}"`);
  const [i, d = ''] = s.split('.');
  const scale = 10n ** BigInt(dec);
  const full = BigInt(i!) * scale + BigInt((d + '0'.repeat(dec)).slice(0, dec) || '0');
  const extra = d.length > dec && Number(d[dec]) >= 5 ? 1n : 0n;
  const n = full + extra;
  if (dec === 0) return n.toString();
  const t = n.toString().padStart(dec + 1, '0');
  return `${t.slice(0, -dec)}.${t.slice(-dec)}`;
}

const cents = (v: string) => Math.round(Number(v) * 100);
const money = (c: number) => (c / 100).toFixed(2);

export function parseNfceXml(xml: string): ParsedDocument {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (e) {
    return { kind: 'desconhecido', error: `XML inválido: ${(e as Error).message}` };
  }

  // ---------- Evento de cancelamento ----------
  const procEvento = obj(doc.procEventoNFe);
  const eventoInf = obj(obj(procEvento.evento ?? doc.evento).infEvento);
  if (Object.keys(eventoInf).length) {
    const tp = str(eventoInf.tpEvento);
    if (tp !== '110111') return { kind: 'desconhecido', error: `Evento ${tp ?? '?'} não tratado (apenas cancelamento 110111).` };
    const ret = obj(obj(procEvento.retEvento).infEvento);
    const cStat = str(ret.cStat);
    return {
      kind: 'cancelamento',
      accessKey: str(eventoInf.chNFe) ?? '',
      at: str(eventoInf.dhEvento) ?? new Date().toISOString(),
      reason: str(obj(eventoInf.detEvento).xJust),
      // 135 = evento registrado; 155 = cancelamento homologado fora de prazo
      registered: cStat === '135' || cStat === '155',
    };
  }

  // ---------- Documento de venda ----------
  const nfe = obj(obj(doc.nfeProc).NFe ?? doc.NFe);
  const inf = obj(nfe.infNFe);
  if (!Object.keys(inf).length) return { kind: 'desconhecido', error: 'Arquivo não é uma NFC-e nem um evento de cancelamento.' };
  try {
    const ide = obj(inf.ide);
    const emit = obj(inf.emit);
    const tot = obj(obj(inf.total).ICMSTot);
    const prot = obj(obj(obj(doc.nfeProc).protNFe).infProt);
    const id = str(inf['@Id']) ?? '';
    const accessKey = (str(prot.chNFe) ?? id.replace(/^NFe/, '')).replace(/\D/g, '');
    if (accessKey.length !== 44) throw new Error('chave de acesso ausente ou inválida');
    const cStat = str(prot.cStat);

    const items: NormalizedSaleItem[] = ((inf.det as unknown[]) ?? []).map((d) => {
      const det = obj(d);
      const prod = obj(det.prod);
      const gross = roundDecimal(str(prod.vProd), 2);
      const discount = roundDecimal(str(prod.vDesc) ?? '0', 2);
      const ean = str(prod.cEAN);
      return {
        lineNo: Number(det['@nItem']),
        code: str(prod.cProd) ?? '',
        ean: ean && /^\d{8,14}$/.test(ean) ? ean : null, // "SEM GTIN" = sem código de barras
        description: str(prod.xProd) ?? '',
        unit: str(prod.uCom),
        quantity: roundDecimal(str(prod.qCom), 3),
        unitPrice: roundDecimal(str(prod.vUnCom), 4),
        gross,
        discount,
        net: money(cents(gross) - cents(discount)),
      };
    });
    if (!items.length) throw new Error('NFC-e sem itens');

    // Pagamentos: o troco (vTroco) é abatido do dinheiro — o PDV registra o valor entregue pelo cliente.
    const pag = obj(inf.pag);
    const payments: NormalizedPayment[] = ((pag.detPag as unknown[]) ?? []).map((p) => {
      const dp = obj(p);
      return { nfceCode: (str(dp.tPag) ?? '99').padStart(2, '0'), amount: roundDecimal(str(dp.vPag), 2), cardBrand: str(obj(dp.card).tBand) };
    });
    let change = cents(roundDecimal(str(pag.vTroco) ?? '0', 2));
    for (const p of payments.filter((x) => x.nfceCode === '01')) {
      const take = Math.min(change, cents(p.amount));
      p.amount = money(cents(p.amount) - take);
      change -= take;
    }
    if (change > 0) {
      const any = payments.find((p) => cents(p.amount) >= change);
      if (any) any.amount = money(cents(any.amount) - change);
    }

    const net = roundDecimal(str(tot.vNF), 2);
    const other = money(cents(roundDecimal(str(tot.vOutro) ?? '0', 2)) + cents(roundDecimal(str(tot.vFrete) ?? '0', 2)) + cents(roundDecimal(str(tot.vSeg) ?? '0', 2)));
    return {
      kind: 'venda',
      sale: {
        externalId: accessKey,
        model: str(ide.mod) ?? '',
        number: str(ide.nNF) ?? '',
        series: str(ide.serie) ?? '',
        issuerDocument: (str(emit.CNPJ) ?? str(emit.CPF) ?? '').replace(/\D/g, ''),
        environment: str(ide.tpAmb) === '2' ? '2' : '1',
        authorized: cStat === '100' || cStat === '150',
        authorizationStatus: cStat,
        soldAt: str(ide.dhEmi) ?? '',
        gross: roundDecimal(str(tot.vProd), 2),
        discount: roundDecimal(str(tot.vDesc) ?? '0', 2),
        other,
        net,
        operator: null,
        items,
        payments: payments.filter((p) => cents(p.amount) > 0),
      },
    };
  } catch (e) {
    return { kind: 'desconhecido', error: `NFC-e com estrutura inesperada: ${(e as Error).message}` };
  }
}
