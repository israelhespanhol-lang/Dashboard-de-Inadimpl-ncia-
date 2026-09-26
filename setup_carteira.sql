-- Criação da Tabela de Carteira em Aberto
CREATE TABLE public.carteira_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  data_base date NOT NULL,
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

ALTER TABLE public.carteira_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Usuários autenticados podem ler carteira" 
  ON public.carteira_history FOR SELECT 
  TO authenticated USING (true);

CREATE POLICY "Usuários autenticados podem inserir carteira" 
  ON public.carteira_history FOR INSERT 
  TO authenticated WITH CHECK (true);

CREATE POLICY "Usuários autenticados podem deletar carteira" 
  ON public.carteira_history FOR DELETE 
  TO authenticated USING (true);
