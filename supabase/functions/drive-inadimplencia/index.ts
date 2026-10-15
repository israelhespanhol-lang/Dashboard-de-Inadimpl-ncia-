// Google Drive -> Supabase. No secrets or customer data belong in source control.
// Modes: validate (default, no DB writes) and commit (requires BRIDGE_WRITE_ENABLED=true).
import ExcelJS from "npm:exceljs@4.4.0";
import { Buffer } from "node:buffer";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

type RecordRow = {
  codigo: string; cnpj: string; cliente: string; documento: string; nf: string;
  emissao: string | null; vencimento: string | null; valor: number; dias: number;
  observacoes: string; gestor: string;
};

const norm = (v: unknown) => String(v ?? "").normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");

const aliases: Record<string, string[]> = {
  codigo: ["codigo pn", "codigo", "cod pn", "cod", "pn"],
  cnpj: ["cnpj", "cpf/cnpj", "cpf cnpj"],
  cliente: ["razao social", "cliente", "nome do cliente", "clientes"],
  documento: ["no.docto.", "nº documento", "no documento", "documento", "doc sap", "lcm"],
  nf: ["no. nf", "nº nf", "no nf", "nf", "nota fiscal"],
  emissao: ["emissao", "data emissao"],
  vencimento: ["vencimento", "data vencimento", "dt vencimento", "novo vencimento"],
  valor: ["valor r$", "valor", "saldo", "valor em aberto", "saldo em aberto", "soma de valor r$"],
  dias: ["dias atraso", "dias em atraso", "dias", "max. de dias atraso"],
  observacoes: ["observacoes", "obs", "motivo", "garantias"],
  gestor: ["vendedor", "gestor", "responsavel"],
};
const canonical = Object.fromEntries(Object.entries(aliases).flatMap(([key, vals]) =>
  vals.map(v => [norm(v), key])
));

function cellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value as unknown;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    if ("result" in o) return o.result;
    if ("text" in o) return o.text;
    if ("richText" in o && Array.isArray(o.richText))
      return o.richText.map(x => (x as { text?: string }).text ?? "").join("");
  }
  return v;
}
function dateValue(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v.valueOf()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    if (v < 1 || v > 100000) return null;
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const br = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  return br ? br[3] + "-" + br[2].padStart(2, "0") + "-" + br[1].padStart(2, "0") : null;
}
function money(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "").replace(/R\$/gi, "").replace(/\s/g, "");
  return Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
}
function validDate(day: string, month: string, year: string): string {
  const d = Number(day), m = Number(month), y = Number(year);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 2000 || y > 2040 || dt.getUTCFullYear() !== y ||
      dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d)
    throw new Error("INVALID_FILE_DATE");
  return [year, month.padStart(2, "0"), day.padStart(2, "0")].join("-");
}
function fileDate(filename: string): string {
  const n = filename.replace(/\.(xlsx|xls)$/i, "");
  let m = n.match(/(?:^|\D)(\d{2})[.\/_-](\d{2})[.\/_-](20\d{2})(?:\D|$)/);
  if (m) return validDate(m[1], m[2], m[3]);
  m = n.match(/(?:^|\D)(\d{2})(\d{2})(20\d{2})(?:\D|$)/);
  if (m) return validDate(m[1], m[2], m[3]);
  throw new Error("DATE_NOT_FOUND_IN_FILENAME");
}
function sheetRecords(sheet: ExcelJS.Worksheet): RecordRow[] {
  let headerRow = 0;
  let cols: Record<string, number> = {};
  for (let n = 1; n <= Math.min(sheet.rowCount, 25); n++) {
    const row = sheet.getRow(n);
    const found: Record<string, number> = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = canonical[norm(cellValue(cell))];
      if (key && !found[key]) found[key] = col;
    });
    if (found.cliente && found.valor && found.dias && found.gestor) {
      cols = found; headerRow = n; break;
    }
  }
  if (!headerRow) throw new Error("REQUIRED_COLUMNS_NOT_FOUND: " + sheet.name);

  const rows: RecordRow[] = [];
  const read = (row: ExcelJS.Row, key: string) =>
    cols[key] ? cellValue(row.getCell(cols[key])) : "";
  for (let n = headerRow + 1; n <= sheet.rowCount; n++) {
    const row = sheet.getRow(n);
    const cliente = String(read(row, "cliente") ?? "").trim();
    if (!cliente || /^total(\s|$)/i.test(cliente)) continue;
    const valor = money(read(row, "valor"));
    const dias = Number(read(row, "dias"));
    if (!Number.isFinite(valor) || valor < 0 || !Number.isInteger(dias)) {
      throw new Error("INVALID_VALUE_OR_DAYS: " + sheet.name + " row " + n);
    }
    rows.push({
      codigo: String(read(row, "codigo") ?? "").trim(),
      cnpj: String(read(row, "cnpj") ?? "").trim(),
      cliente, documento: String(read(row, "documento") ?? "").trim(),
      nf: String(read(row, "nf") ?? "").trim(),
      emissao: dateValue(read(row, "emissao")),
      vencimento: dateValue(read(row, "vencimento")),
      valor, dias,
      observacoes: String(read(row, "observacoes") ?? "").trim(),
      gestor: String(read(row, "gestor") ?? "").trim(),
    });
  }
  return rows;
}
function selectSheets(workbook: ExcelJS.Workbook) {
  const sheets = workbook.worksheets;
  const open = sheets.find(s => norm(s.name).includes("total em aberto"));
  const overdue = sheets.find(s => {
    const n = norm(s.name);
    return n.includes("inadimpl") && !n.includes("analise") && n !== norm(open?.name);
  });
  if (!open || !overdue) throw new Error("MISSING_OPEN_OR_OVERDUE_TAB: " +
    sheets.map(s => s.name).join(" | "));
  return { open, overdue };
}
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2,"0")).join("");
}
async function isAuthorized(request: Request): Promise<boolean> {
  const expected = Deno.env.get("BRIDGE_WEBHOOK_SECRET");
  const supplied = request.headers.get("x-bridge-secret") ?? "";
  if (!expected || expected.length < 32 || supplied.length < 32) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let different = 0;
  for (let i = 0; i < x.length; i++) different |= x[i] ^ y[i];
  return different === 0;
}
function reply(body: unknown, code = 200) {
  return Response.json(body, { status: code });
}

Deno.serve(async request => {
  if (request.method !== "POST") return reply({error:"METHOD_NOT_ALLOWED"}, 405);
  if (!(await isAuthorized(request))) return reply({error:"UNAUTHORIZED"}, 401);
  try {
    const payload = await request.json();
    const mode = payload.mode === "commit" ? "commit" : "validate";
    const id = String(payload.fileId ?? "").trim();
    const name = String(payload.fileName ?? "").trim();
    const encoded = String(payload.contentBase64 ?? "");
    if (!id || !/\.(xlsx)$/i.test(name) || !encoded || encoded.length > 7_000_000) {
      return reply({ error:"INVALID_FILE_OR_SIZE" }, 400);
    }
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    if (bytes.length > 5_000_000) return reply({ error:"FILE_TOO_LARGE" }, 413);
    const sourceHash = toHex(await crypto.subtle.digest("SHA-256", bytes));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes));
    const date = fileDate(name);
    const { open, overdue } = selectSheets(workbook);
    const carteira = sheetRecords(open);
    const inadimplencia = sheetRecords(overdue);
    const totalOpen = carteira.reduce((s,r) => s+r.valor, 0);
    const totalOverdue = inadimplencia.reduce((s,r) => s+r.valor, 0);
    if (!carteira.length || totalOpen < totalOverdue - 0.01)
      return reply({error:"INVALID_CARTEIRA_OR_TOTALS",date},422);
    const summary = {
      date, fileName: name, sourceHash,
      sheets: { carteira: open.name, inadimplencia: overdue.name },
      carteiraCount: carteira.length, overdueCount: inadimplencia.length,
      totalOpen: Math.round(totalOpen*100)/100,
      totalOverdue: Math.round(totalOverdue*100)/100,
    };
    if (mode === "validate") return reply({status:"VALIDATED_NO_WRITE",...summary});

    if (Deno.env.get("BRIDGE_WRITE_ENABLED") !== "true")
      return reply({error:"BRIDGE_WRITE_DISABLED",...summary},403);

    const url = Deno.env.get("SUPABASE_URL");
    const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const key = legacyKey || keys.default;
    if (!url || !key) return reply({error:"SUPABASE_SERVER_CREDENTIALS_MISSING"},503);
    const client = createClient(url, key, {auth:{persistSession:false}});
    const {data, error} = await client.rpc("ingest_inadimplencia_snapshot",{
      p_data_base: date,
      p_drive_file_id: id,
      p_file_name: name,
      p_source_sha256: sourceHash,
      p_source_modified_at: payload.modifiedTime || null,
      p_overdue: inadimplencia,
      p_carteira: carteira,
    });
    if (error) return reply({error:"DATABASE_IMPORT_FAILED",detail:error.message,date},409);
    return reply({...summary, database:data});
  } catch (e) {
    return reply({error:"PARSE_OR_VALIDATION_ERROR",detail:e instanceof Error?e.message:String(e)},422);
  }
});
