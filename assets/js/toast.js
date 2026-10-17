/**
 * toast.js
 * Hệ thống Toast Notification tối giản, thuần Vanilla JS/CSS
 * Tuyệt đối không dùng window.alert()
 */

let toastContainer = null;

function ensureContainer() {
  if (!toastContainer) {
    toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      document.body.appendChild(toastContainer);
    }
  }
  return toastContainer;
}

export function showToast(message, type = 'info', duration = 3500) {
  const container = ensureContainer();
  
  const toast = document.createElement('div');
  toast.className = `minimal-toast toast-${type}`;
  
  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  closeBtn.style.background = 'none';
  closeBtn.style.border = 'none';
  closeBtn.style.color = '#FFFFFF';
  closeBtn.style.opacity = '0.6';
  closeBtn.style.cursor = 'pointer';
  closeBtn.style.fontSize = '1.2rem';
  closeBtn.style.lineHeight = '1';
  closeBtn.style.padding = '0';
  
  closeBtn.onclick = () => {
    toast.remove();
  };
  
  toast.appendChild(textSpan);
  toast.appendChild(closeBtn);
  container.appendChild(toast);
  
  if (duration > 0) {
    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}
