import XLSX from 'xlsx';
const wb = XLSX.readFile('C:/Users/Vasil/Downloads/one drive/Documents/Universal/22.05_vat_excel_many_columns/vat snezanka.xlsx.xlsx');
console.log('Sheets:', wb.SheetNames);
for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const ref = ws['!ref'] || 'A1';
    const range = XLSX.utils.decode_range(ref);
    console.log(`\nSheet: "${name}" rows=${range.e.r+1} cols=${range.e.c+1}`);
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][];
    rows.slice(0, 12).forEach((r, i) => console.log(`  Row ${i+1}:`, JSON.stringify(r).slice(0, 260)));
}
