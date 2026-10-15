# Performance de Pagamentos — Implementação 15/10/2026

## Objetivo
A aba **Histórico Pag.** foi transformada em **Performance de Pagamentos**, mantendo identidade da Compo Expert e sem mexer nas tabelas de inadimplência.

## Arquivos
- `index.html`: painel executivo com filtros, KPIs, gráficos e tabela.
- `payments-dashboard.css`: CSS responsivo isolado.
- `payments-dashboard.js`: visualizações, filtros, cálculos, ranking, exportação e dados locais.
- `script.js`: importação multiarquivo de XLSX/XLS/CSV, cálculo lead-lag e persistência local.
- `compo-payment-timeline.js`: componente de linha do tempo (opcional/recolhível).

## Dados reais versus demonstração
- `Dados demonstrativos` cria clientes fictícios e não grava esses dados na nuvem.
- `Importar planilha` aceita múltiplos arquivos (uma seleção consolida o conjunto).
- Dados reais importados ficam **somente no IndexedDB deste navegador**, até o usuário limpar a base local; **não são enviados automaticamente ao Supabase**. Ao entrar novamente no navegador, a base local é restaurada.
- `Limpar base local` apaga só a cópia no navegador (com confirmação), não toca no banco nem nos arquivos originais.

## Colunas reconhecidas
Obrigatórias: nome/cliente, data de vencimento, data de pagamento, valor.
Opcional: código do cliente, SAP, número da nota, emissão, vendedor/gestor.

São aceitos cabeçalhos como Name/Customer, Due Date, Payment Date, Invoice Value, Valor Pago, Valor Recebido, Seller, Invoice Number.
Quando há valor pago e valor faturado, prioriza-se o valor **pago**.
Se a planilha tiver apenas Invoice Value/Valor da Nota, a importação avisa que pagamentos parciais exigem conferência.

## Fórmulas dos indicadores
- Valor recebido = soma dos valores registrados nas linhas filtradas.
- Sem atraso = data de pagamento até a data de vencimento (delay <= 0).
- Com atraso = pagamento após vencimento (delay > 0).
- Atraso médio e mediano = apenas entre pagamentos atrasados.
- Reincidentes = clientes com dois ou mais pagamentos atrasados no subconjunto filtrado.
- Recuperados após 30/60 dias = soma dos pagamentos com delay > 30 ou > 60.
- Rankings = valor pago com atraso, atraso médio ou contagem de atrasos.
- Gráfico mensal = agrupa por **data do pagamento**, não por vencimento.
- Comparação mensal considera os dois últimos meses com dados no filtro e avisa sobre meses parciais.
- Não subtrair os pagamentos novamente da carteira: a carteira pode já refletir as baixas.

## Testes
Testes sintáticos e simulação isolada de DOM/planilhas confirmaram geração de KPIs, filtros, ranking, SVG de evolução, tabela e parser com vendedores/datas. Não há dados reais de histórico de pagamentos fornecidos até o momento para reconciliação contábil completa.

## Próxima integração opcional
Quando a fonte real do histórico de pagamentos for identificada no Google Drive, criar uma ponte separada e uma tabela dedicada no Supabase, com controle de versões/duplicatas e RLS. Não misturar o fluxo de inadimplência com pagamentos.
