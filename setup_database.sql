-- 1. Criação da Tabela para Empilhamento Histórico
CREATE TABLE public.inadimplencia_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  data_base date NOT NULL, -- Data de referencia da foto (ex: a inadimplência do dia X)
  codigo text,
  cnpj text,
  cliente text,
  documento text,
  nf text,
  emissao date,
  vencimento date,
  valor numeric,
  dias integer,
  observacoes text,
  gestor text,
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Habilita Segurança a nível de linha (Row Level Security - RLS)
ALTER TABLE public.inadimplencia_history ENABLE ROW LEVEL SECURITY;

-- 3. Cria Política de Acesso (Apenas usuários autenticados podem ver e inserir)
CREATE POLICY "Usuários autenticados podem ler" 
  ON public.inadimplencia_history FOR SELECT 
  TO authenticated USING (true);

CREATE POLICY "Usuários autenticados podem inserir" 
  ON public.inadimplencia_history FOR INSERT 
  TO authenticated WITH CHECK (true);

CREATE POLICY "Usuários autenticados podem deletar" 
  ON public.inadimplencia_history FOR DELETE 
  TO authenticated USING (true);
