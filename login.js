document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  const errorMsg = document.getElementById('loginError');

  // Verifica se já está logado no Supabase
  if (window.appSupabase) {
    window.appSupabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        window.location.href = 'index.html';
      }
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    const btn = document.querySelector('.login-btn');
    const originalText = btn.textContent;
    btn.textContent = 'Acessando...';
    btn.style.opacity = '0.8';

    if (window.appSupabase) {
      window.appSupabase.auth.signInWithPassword({
        email: email,
        password: password,
      }).then(({ data, error }) => {
        if (error) {
          showError(error.message);
          btn.textContent = originalText;
          btn.style.opacity = '1';
        } else {
          errorMsg.hidden = true;
          window.location.href = 'index.html';
        }
      });
    } else {
      // Fallback
      showError("Serviço de autenticação offline.");
    }

    function showError(msg = null) {
      errorMsg.textContent = msg || "Credenciais inválidas.";
      errorMsg.hidden = false;
      document.getElementById('password').value = '';
      
      const card = document.querySelector('.login-card');
      card.style.animation = 'shake 0.4s ease-in-out';
      setTimeout(() => {
        card.style.animation = '';
      }, 400);
    }
  });
});
