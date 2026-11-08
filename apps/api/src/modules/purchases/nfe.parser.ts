import { XMLParser } from 'fast-xml-parser';
import { splitGtinFromDescription, validGtin } from '../stock/inventory-xlsx.parser.js';

/** Leitura do XML da NF-e (modelo 55) do fornecedor — somente os campos usados na entrada de mercadoria. */
export interface NfeItem {
  line: number;
  supplierCode: string;
  gtin: string | null;            // GTIN válido (cEAN ou cEANTrib); null = "SEM GTIN" ou inválido
  gtinRaw: string | null;         // como veio na nota (para mostrar quando inválido)
  description: string;
  ncm: string | null;
  unit: string;                   // unidade comercial (uCom)
  quantity: string;               // qCom (até 4 casas)
  unitPrice: string;              // vUnCom
  total: string;                  // vProd (2 casas)
  discount: string;               // vDesc do item
  tribUnit: string | null;
  tribQuantity: string | null;
}
export interface NfeDoc {
  accessKey: string;
  number: string;
  series: string | null;
  model: string;
  issuedAt: string;               // ISO
  authorized: boolean;
  protocolStatus: string | null;
  operation: string | null;       // natOp
  type: string | null;            // tpNF 0 = entrada, 1 = saída
  supplier: { document: string; name: string; tradeName: string | null; stateRegistration: string | null; address: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null };
  recipientDocument: string | null;
  items: NfeItem[];
  totals: { products: string; discount: string; freight: string; insurance: string; other: string; st: string; ipi: string; ii: string; invoice: string };
  installments: { number: string | null; dueDate: string; amount: string }[];
}

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: true,
  isArray: (name) => ['det', 'dup', 'detPag'].includes(name),
});
type Node = Record<string, unknown>;
const obj = (v: unknown): Node => (v && typeof v === 'object' ? (v as Node) : {});
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const dec = (v: unknown, places: number): string => {
  const s = str(v) ?? '0';
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`valor inválido "${s}"`);
  const n = Number(s);
  return n.toFixed(places);
};

export function parseNfeXml(xml: string): NfeDoc {
  let doc: Node;
  try { doc = parser.parse(xml) as Node; } catch (e) { throw new Error(`XML inválido: ${(e as Error).message}`); }
  if (Object.keys(obj(doc.procEventoNFe)).length || Object.keys(obj(doc.evento)).length) throw new Error('Este arquivo é um evento (ex.: cancelamento), não a nota fiscal. Envie o XML da NF-e.');
  const nfe = obj(obj(doc.nfeProc).NFe ?? doc.NFe);
  const inf = obj(nfe.infNFe);
  if (!Object.keys(inf).length) throw new Error('Arquivo não é um XML de NF-e. Peça ao fornecedor o arquivo .xml da nota (o PDF/DANFE não serve para importação).');
  const ide = obj(inf.ide);
  const emit = obj(inf.emit);
  const ender = obj(emit.enderEmit);
  const dest = obj(inf.dest);
  const tot = obj(obj(inf.total).ICMSTot);
  const prot = obj(obj(obj(doc.nfeProc).protNFe).infProt);
  const model = str(ide.mod) ?? '55';
  const accessKey = (str(prot.chNFe) ?? (str(inf['@Id']) ?? '').replace(/^NFe/, '')).replace(/\D/g, '');
  if (accessKey.length !== 44) throw new Error('Chave de acesso da nota ausente ou inválida.');

  const items: NfeItem[] = ((inf.det as unknown[]) ?? []).map((d, idx) => {
    const det = obj(d);
    const prod = obj(det.prod);
    const pick = (v: string | null) => (v && /^\d{8,14}$/.test(v) && validGtin(v) ? v : null);
    const ean = str(prod.cEAN);
    const eanTrib = str(prod.cEANTrib);
    const split = splitGtinFromDescription((str(prod.xProd) ?? '').replace(/\s+/g, ' ').trim());
    const gtin = pick(ean) ?? pick(eanTrib) ?? split.gtin;
    const raw = [ean, eanTrib].find((v) => v && !/^sem gtin$/i.test(v)) ?? null;
    return {
      line: Number(str(det['@nItem']) ?? idx + 1),
      supplierCode: str(prod.cProd) ?? String(idx + 1),
      gtin, gtinRaw: raw,
      description: split.description,
      ncm: str(prod.NCM),
      unit: (str(prod.uCom) ?? 'UN').toUpperCase(),
      quantity: dec(prod.qCom, 3),
      unitPrice: dec(prod.vUnCom, 4),
      total: dec(prod.vProd, 2),
      discount: dec(prod.vDesc ?? '0', 2),
      tribUnit: str(prod.uTrib)?.toUpperCase() ?? null,
      tribQuantity: str(prod.qTrib) ? dec(prod.qTrib, 3) : null,
    };
  });
  if (!items.length) throw new Error('A nota não tem itens.');
  const dups = ((obj(obj(inf.cobr)).dup as unknown[]) ?? []).map((x) => {
    const d = obj(x);
    return { number: str(d.nDup), dueDate: str(d.dVenc) ?? '', amount: dec(d.vDup, 2) };
  }).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.dueDate));
  const cStat = str(prot.cStat);
  return {
    accessKey, model,
    number: str(ide.nNF) ?? '', series: str(ide.serie),
    issuedAt: str(ide.dhEmi) ?? (str(ide.dEmi) ? `${str(ide.dEmi)}T12:00:00-03:00` : new Date().toISOString()),
    authorized: cStat === '100' || cStat === '150',
    protocolStatus: cStat,
    operation: str(ide.natOp), type: str(ide.tpNF),
    supplier: {
      document: (str(emit.CNPJ) ?? str(emit.CPF) ?? '').replace(/\D/g, ''),
      name: str(emit.xNome) ?? 'Fornecedor', tradeName: str(emit.xFant), stateRegistration: str(emit.IE),
      address: [str(ender.xLgr), str(ender.nro), str(ender.xBairro)].filter(Boolean).join(', ') || null,
      city: str(ender.xMun), state: str(ender.UF), zip: str(ender.CEP), phone: str(ender.fone),
    },
    recipientDocument: (str(dest.CNPJ) ?? str(dest.CPF) ?? '').replace(/\D/g, '') || null,
    items,
    totals: {
      products: dec(tot.vProd, 2), discount: dec(tot.vDesc ?? '0', 2), freight: dec(tot.vFrete ?? '0', 2), insurance: dec(tot.vSeg ?? '0', 2),
      other: dec(tot.vOutro ?? '0', 2), st: dec(tot.vST ?? '0', 2), ipi: dec(tot.vIPI ?? '0', 2), ii: dec(tot.vII ?? '0', 2), invoice: dec(tot.vNF, 2),
    },
    installments: dups,
  };
}
