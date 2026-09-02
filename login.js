document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  const errorMsg = document.getElementById('loginError');

  // If already logged in, redirect to dashboard
  if (sessionStorage.getItem('compo_auth') === 'true') {
    window.location.href = 'index.html';
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    // Dummy authentication check
    if ((email === 'admin' || email === 'admin@compo-expert.com') && password === 'admin') {
      sessionStorage.setItem('compo_auth', 'true');
      errorMsg.hidden = true;
      
      const btn = document.querySelector('.login-btn');
      btn.textContent = 'Acessando...';
      btn.style.opacity = '0.8';

      setTimeout(() => {
        window.location.href = 'index.html';
      }, 600);
    } else {
      errorMsg.hidden = false;
      document.getElementById('password').value = '';
      
      // Shake animation for error
      const card = document.querySelector('.login-card');
      card.style.animation = 'shake 0.4s ease-in-out';
      setTimeout(() => {
        card.style.animation = '';
      }, 400);
    }
  });
});
