const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeCommunication}=require('../netlify/functions/services/djen');

test('match gratuito por nome exige revisão',()=>{const result=normalizeCommunication({id:1,numero_processo:'0001',siglaTribunal:'TJSP',nomeClasse:'Recuperação Judicial',destinatarios:[{nome:'EMPRESA TESTE LTDA'}]}, {razaoSocial:'EMPRESA TESTE LTDA',cnpj:'11222333000181'});assert.equal(result.matchMethod,'NOME_EXATO');assert.equal(result.needsReview,true);assert.equal(result._matched,true);});
test('CNPJ no destinatário produz correspondência exata',()=>{const result=normalizeCommunication({id:1,destinatarios:[{nome:'EMPRESA TESTE LTDA',cpf_cnpj:'11222333000181'}]}, {razaoSocial:'EMPRESA TESTE LTDA',cnpj:'11222333000181'});assert.equal(result.matchMethod,'CNPJ_EXATO');assert.equal(result.needsReview,false);});
