/** Gera um PDF mínimo (texto em posições x,y) no leiaute do relatório de inventário do PDV — só para testes. */
export function makeInventoryPdf(rows: { x: number; y: number; text: string }[][]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objs: string[] = [];
  const pageIds: number[] = [];
  // 1 catálogo, 2 páginas, 3 fonte; depois pares (página, conteúdo)
  let next = 4;
  const pageObjs: string[] = [];
  for (const page of rows) {
    const content = page.map((t) => `BT /F1 8 Tf ${t.x} ${t.y} Td (${esc(t.text)}) Tj ET`).join('\n');
    const pid = next++, cid = next++;
    pageIds.push(pid);
    pageObjs.push(`${pid} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cid} 0 R >>\nendobj\n`);
    pageObjs.push(`${cid} 0 obj\n<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream\nendobj\n`);
  }
  objs.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objs.push(`2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>\nendobj\n`);
  objs.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
  objs.push(...pageObjs);
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const o of objs) { offsets.push(Buffer.byteLength(body, 'latin1')); body += o; }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** Linha de item como o PDV imprime (colunas em posições fixas). */
export function itemRow(y: number, code: string, desc: string, qty: string, cost: string, total: string) {
  return [
    { x: 40, y, text: `${code} - ${desc}` }, { x: 330, y, text: 'UN' }, { x: 370, y, text: '0' },
    { x: 400, y, text: qty }, { x: 470, y, text: cost }, { x: 540, y, text: total },
  ];
}
