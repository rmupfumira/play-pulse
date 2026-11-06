const form = document.getElementById('login-form');
const password = document.getElementById('password');
const reveal = document.getElementById('reveal');
const error = document.getElementById('login-error');
const submit = document.getElementById('login-submit');

reveal.addEventListener('click', () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  reveal.textContent = show ? 'Hide' : 'Show';
  reveal.setAttribute('aria-pressed', show);
  password.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  submit.disabled = true;
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    if (response.ok) {
      location.replace('/');
      return;
    }
    const failure = await response.json().catch(() => null);
    error.textContent = failure?.error?.message ?? 'Could not sign in. Try again.';
  } catch {
    error.textContent = 'Could not reach the dashboard. Check your connection.';
  }
  error.hidden = false;
  password.select();
  submit.disabled = false;
});
