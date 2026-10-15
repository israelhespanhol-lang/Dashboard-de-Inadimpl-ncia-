# Série diária e picos de inadimplência (2022–2026)

## Objetivo
A aba **Taxa** deve mostrar as variações de cada data histórica (em vez de um único ponto por mês ou só o último dia). Picos máximo e mínimo são calculados sobre **todos os dias do período e dos anos selecionados**.

## Cálculo
**Taxa = soma dos saldos da tabela `inadimplencia_history` da data ÷ soma dos valores de `carteira_history` da MESMA data.** O resultado é multiplicado por 100 para exibição, em porcentagem.

Cada data usada está presente em ambas as tabelas. A base de inadimplentes é somada como registrada no Excel, incluindo ajustes de sinal. Não extrapolamos datas sem arquivo, nem somamos posições diárias.

Exemplo conferível: em 26/08/2026, R$ 13.286.506,56 / R$ 72.811.274,25 = 18,25%.

## Instalação segura — necessária para habilitar o gráfico
1. No Supabase > SQL Editor > New query, executar `bridge/sql/05_daily_rate.sql`. Cria somente **tabela de cache**, **RPC autenticada** e **gatilho de atualização** para futuras importações.
2. Abrir `bridge/sql/06_backfill_daily_rate.sql` e executar o preenchimento **ano a ano**, de 2022 a 2026. Cada execução é idempotente e só modifica o cache.
3. Execute as consultas de verificação incluídas no final do arquivo. Esperar aproximadamente o total de dias existentes nas duas tabelas; lacunas devem ser investigadas sem inventar valores.
4. Abrir `https://dashboard-de-inadimpl-ncia.vercel.app` e atualizar a aba Taxa. Deve exibir pontos diários, máximos, mínimos e variação em pontos percentuais.
5. Testar o filtro Ano e Período: picos devem mudar junto ao período escolhido.

## Considerações importantes
- Série diária é **consolidada para toda a empresa**. Não é afetada pelos filtros Cliente, Vendedor e Pesquisa. A interface explica isso quando esses filtros estiverem ativos; eles seguem funcionando nos outros painéis.
- Apenas Ano e Período alteram o gráfico Taxa.
- **Evolução** permanece mensal, com o último registro disponível de cada mês.
- A importação de um novo snapshot via função `ingest_inadimplencia_snapshot` cria ou atualiza automaticamente o dia de taxa correspondente.
- O histórico efetivamente presente no banco de carteira começa em 2022 e chega até 26/08/2026 segundo última conferência. Para mostrar 2026-09 e 2026-10, a ponte ainda precisa importar os arquivos.
- Não é necessário atualizar `payment_history` nem qualquer outra tabela de pagamentos para este gráfico.
- A consolidação diária retorna aproximadamente 1100 linhas, sem transportar mais de 1,6 milhão de títulos para o navegador.
- O SQL não faz `DELETE`/`UPDATE` nas tabelas `carteira_history` ou `inadimplencia_history`; apenas atualiza sua tabela de cache.
- Não atribuir à IA acesso ao Excel ou à taxa oficial da aba análise sem a planilha efetivamente ser inspecionada: aqui a série é derivada diretamente dos saldos registrados no banco.

## Estado
A interface e os SQLs estão versionados no GitHub. A permissão do conector Supabase para leitura/escrita ainda está negada, portanto os comandos de banco não foram executados automaticamente.
