const test=require('node:test');
const assert=require('node:assert/strict');
const Core=require('../assets/legal-core');

test('limpa e valida CNPJ',()=>{assert.equal(Core.cleanCnpj('11.222.333/0001-81'),'11222333000181');assert.equal(Core.validCnpj('11.222.333/0001-81'),true);assert.equal(Core.validCnpj('11.111.111/1111-11'),false);});
test('classifica eventos jurídicos',()=>{assert.equal(Core.classifyEvent('Processamento da recuperação judicial deferido'),'RECUPERACAO_JUDICIAL_DEFERIDA');assert.equal(Core.classifyEvent('Falência decretada'),'FALENCIA_DECRETADA');assert.equal(Core.classifyEvent('Execução fiscal'),'EXECUCAO_FISCAL');});
test('score inclui motivo e respeita teto',()=>{const result=Core.calculateScore([{event:'Pedido de falência',processNumber:'1'},{event:'Execução fiscal',processNumber:'2'},{event:'Execução fiscal',processNumber:'3'},{event:'Execução fiscal',processNumber:'4'}]);assert.equal(result.score,100);assert.equal(result.label,'Crítico');assert.ok(result.reasons.some(r=>r.type==='MULTIPLAS_EXECUCOES'));});
test('matching prioriza CNPJ e nomes aproximados exigem revisão',()=>{const companies=[{id:'a',cnpj:'11222333000181',razaoSocial:'ABC LOGISTICA E TRANSPORTES LTDA',aliases:['ABC TRANSPORTES']}];assert.equal(Core.matchCompany({cnpj:'11.222.333/0001-81'},companies).method,'CNPJ_EXATO');const approximate=Core.matchCompany({razaoSocial:'ABC LOGISTICA TRANSPORTES'},companies);assert.ok(approximate);assert.equal(approximate.needsReview,true);});
test('deduplica evento repetido',()=>{const item={source:'DataJud',processNumber:'1',tribunal:'TJSP',companyId:'a',event:'Execução',date:'2026-08-26'};assert.equal(Core.dedupe([item,{...item,id:'outro'}]).length,1);});
