// Configuração do Cliente Supabase
// Adicione suas chaves aqui (disponíveis em Configurações > API no painel do Supabase)
const SUPABASE_URL = 'https://hylycnzcnkwlqjwpuycc.supabase.co/rest/v1/';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh5bHljbnpjbmt3bHFqd3B1eWNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0Mjc0MzksImV4cCI6MjEwNjAwMzQzOX0.pqgMoR3aePjZ3HiuKPavXn_oCkrfC6MsQeVkE-btH4c';

// Inicializa o cliente se o objeto Supabase existir
let supabaseClient = null;
if (window.supabase) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
  console.error("A biblioteca do Supabase não foi carregada no HTML.");
}

// Expõe a instância globalmente para o resto do app
window.appSupabase = supabaseClient;
