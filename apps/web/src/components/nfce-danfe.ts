import QRCode from 'qrcode';

export interface FiscalDoc {
  id: string; status: 'pendente' | 'autorizada' | 'rejeitada' | 'cancelada'; environment: 'homologacao' | 'producao';
  number: string | null; series: string | null; access_key: string | null; protocol: string | null; qrcode_url: string | null; consult_url: string | null;
  sefaz_message: string | null; last_error: string | null; authorized_at: string | null; cancel_reason: string | null;
}
export interface DanfeSale {
  number: string; sold_at: string; gross_amount: string; discount_amount: string; net_amount: string; status: string;
  customer_name: string | null; customer_document: string | null; operator_name: string | null;
  items: { external_code: string; description: string; unit: string | null; quantity: string; unit_price: string; discount_amount: string; net_amount: string }[];
  payments: { method_name: string; amount: string; change_amount: string }[];
  company: { name: string | null; tradeName: string | null; document: string | null; stateRegistration: string | null; address: string | null; city: string | null };
  fiscal: FiscalDoc;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const num = (v: string | number, dec = 2) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '');
const doc = (d: string | null) => {
  if (!d) return '';
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
};

/** DANFE NFC-e em bobina 80 mm (impressora térmica), com QR Code da SEFAZ. */
export async function printNfce(r: DanfeSale, copy = false) {
  const w = window.open('', '_blank', 'width=360,height=700');
  if (!w) { alert('Permita pop-ups deste site para imprimir a NFC-e.'); return; }
  const f = r.fiscal;
  const qr = f.qrcode_url ? await QRCode.toDataURL(f.qrcode_url, { margin: 1, width: 180, errorCorrectionLevel: 'M' }) : null;
  const c = r.company;
  const qtyItems = r.items.reduce((s, i) => s + Number(i.quantity), 0);
  const change = r.payments.reduce((s, p) => s + Number(p.change_amount), 0);
  const key = (f.access_key ?? '').replace(/(\d{4})(?=\d)/g, '$1 ');
  const homolog = f.environment === 'homologacao';
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>NFC-e ${esc(f.number ?? '')}</title><style>
    @page { size: 80mm auto; margin: 2mm 3mm; }
    body { font: 10px/1.25 Arial, Helvetica, sans-serif; width: 72mm; margin: 0; color: #000; }
    .c { text-align: center; } .r { text-align: right; white-space: nowrap; } .b { font-weight: bold; }
    table { width: 100%; border-collapse: collapse; } th { font-size: 9px; text-align: left; border-bottom: 1px solid #000; }
    td { vertical-align: top; padding: 1px; } hr { border: 0; border-top: 1px dashed #000; margin: 3px 0; }
    .box { border: 1px solid #000; padding: 2px; margin: 3px 0; text-align: center; font-weight: bold; }
    .key { font-family: monospace; font-size: 9px; }
  </style></head><body>
    <div class="c b">${esc(c.name ?? '')}</div>
    <div class="c">CNPJ: ${esc(doc(c.document))}${c.stateRegistration ? ` &nbsp; IE: ${esc(c.stateRegistration)}` : ''}</div>
    ${c.address ? `<div class="c">${esc(c.address)}</div>` : ''}
    <hr>
    <div class="c b">DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica${copy ? ' — 2ª VIA' : ''}</div>
    ${homolog ? '<div class="box">EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL</div>' : ''}
    ${f.status === 'cancelada' ? '<div class="box">NFC-e CANCELADA</div>' : ''}
    <table><thead><tr><th>CÓD</th><th>DESCRIÇÃO</th><th class="r">QTD</th><th>UN</th><th class="r">VL UN</th><th class="r">VL TOTAL</th></tr></thead><tbody>
    ${r.items.map((i) => `<tr><td>${esc(i.external_code)}</td><td>${esc(i.description)}</td><td class="r">${num(i.quantity, Number(i.quantity) % 1 ? 3 : 0)}</td><td>${esc(i.unit ?? 'UN')}</td><td class="r">${num(i.unit_price)}</td><td class="r">${num(Number(i.net_amount) + Number(i.discount_amount))}</td></tr>`).join('')}
    </tbody></table>
    <hr>
    <table>
      <tr><td>Qtd. total de itens</td><td class="r">${num(qtyItems, qtyItems % 1 ? 3 : 0)}</td></tr>
      <tr><td>Valor total R$</td><td class="r">${num(r.gross_amount)}</td></tr>
      ${Number(r.discount_amount) ? `<tr><td>Desconto R$</td><td class="r">${num(r.discount_amount)}</td></tr>` : ''}
      <tr class="b"><td>Valor a pagar R$</td><td class="r">${num(r.net_amount)}</td></tr>
      <tr class="b"><td>FORMA DE PAGAMENTO</td><td class="r">VALOR PAGO R$</td></tr>
      ${r.payments.map((p) => `<tr><td>${esc(p.method_name)}</td><td class="r">${num(Number(p.amount) + Number(p.change_amount))}</td></tr>`).join('')}
      ${change > 0 ? `<tr><td>Troco R$</td><td class="r">${num(change)}</td></tr>` : ''}
    </table>
    <hr>
    <div class="c b">Consulte pela Chave de Acesso em</div>
    <div class="c">${esc(f.consult_url ?? '')}</div>
    <div class="c key">${esc(key)}</div>
    <hr>
    <div class="c b">CONSUMIDOR</div>
    <div class="c">${r.customer_document ? `CPF/CNPJ: ${esc(doc(r.customer_document))}${r.customer_name ? ` — ${esc(r.customer_name)}` : ''}` : 'CONSUMIDOR NÃO IDENTIFICADO'}</div>
    <hr>
    <div class="c b">NFC-e nº ${esc(f.number ?? '')} &nbsp; Série ${esc(f.series ?? '')} &nbsp; ${esc(dt(r.sold_at))}</div>
    <div class="c">Protocolo de autorização: ${esc(f.protocol ?? '')}</div>
    <div class="c">Data de autorização: ${esc(dt(f.authorized_at))}</div>
    ${qr ? `<div class="c"><img src="${qr}" width="160" height="160" alt="QR Code NFC-e"></div>` : ''}
    ${r.operator_name ? `<div class="c">Operador: ${esc(r.operator_name)} · Venda nº ${esc(r.number)}</div>` : ''}
    <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 500); };</script>
  </body></html>`);
  w.document.close();
}
