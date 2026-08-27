# Monitoramento Empresarial

## Arquitetura encontrada

O projeto é uma aplicação estática em HTML, CSS e JavaScript. Não há framework, banco de dados, autenticação, usuários ou migrations. As integrações externas usam Netlify Functions.

## Funcionalidades desta versão

- Dashboard de risco, empresas, alertas, processos, histórico e configurações.
- Cadastro, edição, exclusão e detalhamento de empresas.
- Persistência local no navegador (`localStorage`, chave `compo_legal_monitor_v1`).
- Importação CSV/XLSX com relatório de importados, duplicados, inválidos e ignorados.
- Validação matemática de CNPJ, deduplicação e matching por CNPJ, nome, fantasia, aliases e similaridade.
- Classificação normalizada de eventos e score explicável de 0 a 100.
- Provider DataJud executado somente no backend e tratado como cobertura complementar.
- Mocks explicitamente identificados e desativados para consulta externa.

## Backend e endpoints

- `POST /.netlify/functions/datajud-search`
  - Entrada: `{ company, tribunal }`
  - Enquanto não houver pesquisa pública confiável por CNPJ, retorna cobertura `INCONCLUSIVE` e não classifica a empresa como livre de processos.
- `POST /.netlify/functions/check-rj` (integração cadastral anterior)
- `POST /.netlify/functions/legal-search`
  - Sem token comercial: usa gratuitamente a API pública do DJEN/CNJ por nome da parte.
  - Correspondências do DJEN sem CNPJ são salvas para revisão e não alteram o score.
  - Com `ESCAVADOR_API_TOKEN`: pesquisa nacional exata por CNPJ e pagina até 500 processos por empresa.

## Variáveis de ambiente

Copie os nomes de `.env.example` para as variáveis do ambiente de hospedagem:

- `DATAJUD_API_KEY`: chave pública vigente divulgada pelo CNJ, sem o prefixo `APIKey`.
- `CNPJ_API_TOKEN`: token do provider cadastral anterior.
- `ESCAVADOR_API_TOKEN`: Bearer token da API do Escavador para descoberta nacional por CNPJ.

Não coloque valores reais em arquivos públicos ou no JavaScript do navegador.

## DataJud

Os providers estão separados em:

- `netlify/functions/services/datajud.js`
- `netlify/functions/providers/tribunals.js`
- `netlify/functions/services/escavador.js`
- `netlify/functions/services/djen.js`

Tribunais adicionais podem ser incluídos no mapa central sem alterar a interface. O frontend nunca recebe a chave.

## Como testar

```powershell
node --test tests/legal-core.test.js
```

Para testar a interface localmente:

```powershell
python -m http.server 8000 --bind 127.0.0.1
```

Abra `http://127.0.0.1:8000/#monitor-empresarial`. As Netlify Functions exigem execução com Netlify Dev ou deploy para responder.

## Migrations

Não há migrations nesta versão porque o projeto não possui banco de dados. A estrutura conceitual futura deverá incluir `companies`, `company_aliases`, `legal_cases`, `case_events`, `risk_scores`, `alerts`, `monitoring_runs`, `monitoring_errors` e `data_sources`.

## Limitações conhecidas

- Os dados ficam no navegador e não são compartilhados entre usuários ou dispositivos.
- O agendamento fica salvo como preferência, mas jobs contínuos exigem banco persistente e worker/backend.
- A API Pública do DataJud não garante localização de processos por CNPJ/nome da parte. Ela deve detalhar processos já conhecidos; a descoberta empresarial requer outro provider autorizado.
- Correspondências aproximadas são marcadas pelo motor, mas a fila visual de revisão é uma próxima etapa.
- A API pública do DataJud pode alterar chave, campos e limites; o resultado precisa de revisão humana.

## Próximos passos recomendados

1. Adicionar banco Postgres e autenticação.
2. Migrar o armazenamento local para tabelas persistentes com controle de acesso.
3. Criar fila/worker com retry, backoff e agendamento real.
4. Consultar múltiplos tribunais por lote e salvar cursor/estado.
5. Implementar tela dedicada para revisão de correspondências aproximadas.
