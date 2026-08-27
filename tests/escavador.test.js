const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeProcess}=require('../netlify/functions/services/escavador');

test('normaliza processo retornado pelo provider nacional',()=>{const result=normalizeProcess({id:123,numero_cnj:'0000000-00.2026.8.26.0000',titulo:'Recuperação Judicial',data_inicio:'2026-08-25',tribunal:{sigla:'TJSP'},fontes:[{unidade_origem:{nome:'1ª Vara'}}]});assert.equal(result.processNumber,'0000000-00.2026.8.26.0000');assert.equal(result.tribunal,'TJSP');assert.equal(result.source,'Escavador');assert.equal(result.court,'1ª Vara');});
