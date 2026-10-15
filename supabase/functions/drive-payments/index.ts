// Fonte única XLSX de pagamentos -> Supabase.
// Não disponibilize BRIDGE_WEBHOOK_SECRET nem service_role no navegador ou no GitHub.
import ExcelJS from "npm:exceljs@4.4.0";
import { Buffer } from "node:buffer";
import { createClient } from "npm:@supabase/supabase-js@2.57.0";

const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .trim().toLowerCase().replace(/\s+/g," ");
const aliases: Record<string,string[]> = {
  customer_code:["customer","customer code","customer number","codigo pn","codigo do cliente","codigo cliente"],
  customer_name:["name","nome","nome do cliente","razao social","cliente","customer name"],
  seller:["seller","vendedor","gestor","sales rep","representante","responsavel"],
  sap:["sap number","sap","documento sap","n sap","no sap"],
  invoice:["invoice","invoice number","nota fiscal","nf","numero nf","numero da nf"],
  issue_date:["invoice date","data de emissao","emissao","issue date"],
  due_date:["due date","data de vencimento","vencimento","due"],
  payment_date:["payment date","data de pagamento","data do pagamento","data do pagamento efetivo","pagamento","payment"],
  paid_amount:["valor recebido","valor pago","valor efetivamente pago","payment amount","amount paid","paid amount"],
  invoice_amount:["invoice value","valor da nota","valor","amount","invoice amount"],
};
const columns = Object.fromEntries(Object.entries(aliases).flatMap(([key,values])=>values.map(v=>[norm(v),key])));
function cell(cell: ExcelJS.Cell): unknown {
  const v: unknown=cell.value;
  if(v && typeof v==="object" && !(v instanceof Date)){
    const obj=v as Record<string,unknown>;
    if("result" in obj)return obj.result;
    if("text" in obj)return obj.text;
    if(Array.isArray(obj.richText))return obj.richText.map(x=>(x as {text?:string}).text??"").join("");
  }
  return v;
}
function isoDate(value:unknown):string|null {
  if(value instanceof Date)return Number.isNaN(+value)?null:value.toISOString().slice(0,10);
  if(typeof value==="number" && value>0 && value<100000)
    return new Date(Date.UTC(1899,11,30)+Math.floor(value)*86400000).toISOString().slice(0,10);
  const s=String(value??"").trim();
  if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);
  const d=s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if(!d)return null;
  const y=+d[3],m=+d[2],day=+d[1],date=new Date(Date.UTC(y,m-1,day));
  return date.getUTCDate()===day&&date.getUTCMonth()+1===m&&date.getUTCFullYear()===y?
    [d[3],d[2].padStart(2,"0"),d[1].padStart(2,"0")].join("-"):null;
}
function amount(value:unknown):number|null {
  if(typeof value==="number")return Number.isFinite(value)?Math.round(value*100)/100:null;
  let v=String(value??"").replace(/R\$/gi,"").replace(/\s/g,"");
  if(!v)return null;
  if(v.includes(","))v=v.replace(/\./g,"").replace(",",".");
  const n=Number(v);return Number.isFinite(n)?Math.round(n*100)/100:null;
}
type RecordRow = {
 source_row:number;source_sheet:string;customer_code:string;customer_name:string;
 seller:string;sap:string;invoice:string;issue_date:string|null;
 due_date:string;payment_date:string;amount:number;days_delay:number;
};
function parseWorkbook(workbook:ExcelJS.Workbook, sheetOverride:string|null) {
  const candidates:{sheet:ExcelJS.Worksheet; header:number;indexes:Record<string,number>}[]=[];
  for(const sheet of workbook.worksheets){
    for(let rowNum=1;rowNum<=Math.min(30,sheet.rowCount);rowNum++){
      const found:Record<string,number>={};
      sheet.getRow(rowNum).eachCell({includeEmpty:false},(c,col)=>{
        const key=columns[norm(cell(c))];if(key && !found[key])found[key]=col;
      });
      if(found.customer_name && found.due_date && found.payment_date && (found.paid_amount || found.invoice_amount)){
        candidates.push({sheet,header:rowNum,indexes:found});break;
      }
    }
  }
  if(!candidates.length)throw Error("PAYMENT_COLUMNS_NOT_FOUND: cliente, vencimento, pagamento e valor são necessários.");
  const selected=sheetOverride?
    candidates.filter(x=>norm(x.sheet.name)===norm(sheetOverride)):candidates;
  if(!selected.length)throw Error("SELECTED_PAYMENT_SHEET_NOT_FOUND");
  if(selected.length>1)throw Error("MULTIPLE_PAYMENT_SHEETS: informe PAYMENTS_SHEET_NAME para evitar duplicatas.");
  const {sheet,header,indexes}=selected[0];
  const get=(row:ExcelJS.Row,key:string)=>indexes[key]?cell(row.getCell(indexes[key])):null;
  const usesInvoice=!indexes.paid_amount;
  const rows:RecordRow[]=[];
  let invalid=0;
  for(let n=header+1;n<=sheet.rowCount;n++){
    const row=sheet.getRow(n),name=String(get(row,"customer_name")??"").trim();
    if(!name || /^total( geral)?$/i.test(name))continue;
    const due=isoDate(get(row,"due_date")),paid=isoDate(get(row,"payment_date"));
    const val=amount(get(row,usesInvoice?"invoice_amount":"paid_amount"));
    if(!due||!paid||val===null){invalid++;continue;}
    const days=Math.round((Date.parse(paid+"T00:00:00Z")-Date.parse(due+"T00:00:00Z"))/86400000);
    rows.push({source_row:n,source_sheet:sheet.name,
      customer_code:String(get(row,"customer_code")??"").trim(),
      customer_name:name,seller:String(get(row,"seller")??"").trim(),
      sap:String(get(row,"sap")??"").trim(),
      invoice:String(get(row,"invoice")??"").trim(),
      issue_date:isoDate(get(row,"issue_date")),
      due_date:due,payment_date:paid,amount:val,days_delay:days});
  }
  if(!rows.length)throw Error("NO_PAYMENT_ROWS_FOUND");
  if(invalid)throw Error("INVALID_PAYMENT_ROWS: "+invalid+" linhas precisam de revisão. Nenhuma linha foi gravada.");
  if(rows.length>25000)throw Error("PAYMENT_FILE_TOO_MANY_ROWS: o importador exige carga em blocos acima de 25.000 linhas.");
  const totalReceived=Math.round(rows.reduce((sum,r)=>sum+r.amount,0)*100)/100;
  return {rows,summary:{sheet:sheet.name,rowCount:rows.length,totalReceived,
    warnings:usesInvoice?["VALOR_DA_NOTA_USED_AS_RECEIVED: confirmar se a base contém pagamentos parciais"]:[]}};
}
function json(body:unknown,status=200){return Response.json(body,{status});}
async function authorized(request:Request){
  const expected=Deno.env.get("BRIDGE_WEBHOOK_SECRET")||"",given=request.headers.get("x-bridge-secret")||"";
  if(expected.length<32||given.length<32)return false;
  const encoder=new TextEncoder();
  const [a,b]=await Promise.all([crypto.subtle.digest("SHA-256",encoder.encode(expected)),
    crypto.subtle.digest("SHA-256",encoder.encode(given))]);
  const x=new Uint8Array(a),y=new Uint8Array(b);
  return x.reduce((n,v,i)=>n|(v^y[i]),0)===0;
}
Deno.serve(async request=>{
 if(request.method!=="POST")return json({error:"METHOD_NOT_ALLOWED"},405);
 if(!(await authorized(request)))return json({error:"UNAUTHORIZED"},401);
 try {
  const payload=await request.json();
  const mode=payload.mode==="commit"?"commit":"validate";
  const fileId=String(payload.fileId||"").trim(),fileName=String(payload.fileName||"").trim();
  const encoded=String(payload.contentBase64||"");
  if(!fileId || !/\.xlsx$/i.test(fileName) || encoded.length>17_000_000 || !encoded)
    return json({error:"INVALID_FILE_OR_SIZE: exige XLSX até 12MB"},400);
  const bytes=Uint8Array.from(atob(encoded),x=>x.charCodeAt(0));
  if(bytes.byteLength>12_000_000)return json({error:"PAYMENTS_FILE_TOO_LARGE"},413);
  const hash=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))]
    .map(x=>x.toString(16).padStart(2,"0")).join("");
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  const {rows,summary}=parseWorkbook(workbook,String(payload.sheetName||"")||null);
  const response={...summary,fileName,sourceHash:hash};
  if(mode==="validate")return json({status:"VALIDATED_NO_WRITE",...response});
  if(Deno.env.get("BRIDGE_WRITE_ENABLED")!=="true" || Deno.env.get("PAYMENTS_WRITE_ENABLED")!=="true")
    return json({error:"PAYMENT_WRITE_DISABLED",...response},403);
  if(summary.warnings.length)return json({error:"PAYMENT_AMOUNT_AMBIGUOUS",...response},422);
  const url=Deno.env.get("SUPABASE_URL"), legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const keys=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}");
  const key=legacy||keys.default;
  if(!url||!key)return json({error:"SERVER_CREDENTIALS_MISSING"},503);
  const client=createClient(url,key,{auth:{persistSession:false}});
  const {data,error}=await client.rpc("ingest_payment_history",{
    p_source_key:fileId,p_file_name:fileName,p_sha256:hash,p_rows:rows
  });
  if(error)return json({error:"DATABASE_PAYMENT_IMPORT_FAILED",detail:error.message},409);
  return json({status:"IMPORTED",...response,database:data});
 }catch(e){return json({error:"PAYMENT_VALIDATION_FAILED",detail:e instanceof Error?e.message:String(e)},422);}
});
