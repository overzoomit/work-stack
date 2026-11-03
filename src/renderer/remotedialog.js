// "Connect to a remote host" dialog: host/user/port/path/session, validated by
// the same rules the backend applies before building the SSH command.
import { $, leave } from './ui.js';
import { normalizeRemote } from './remoteproject.js';

function close(modal, resolve, result) {
  leave(modal, () => {
    modal.hidden = true;
    resolve(result);
  });
}

export function openRemoteProjectDialog() {
  return new Promise((resolve) => {
    const modal = $('#remote-modal');
    if (!modal) return resolve(null);
    const form = $('#remote-form');
    const error = $('#remote-error');
    const host = $('#remote-host');
    const user = $('#remote-user');
    const port = $('#remote-port');
    const path = $('#remote-path');
    const session = $('#remote-session');
    error.hidden = true;
    form.reset();
    port.placeholder = '22';
    modal.hidden = false;
    host.focus();

    const finish = (result) => {
      form.onsubmit = null;
      $('#remote-cancel').onclick = null;
      modal.onkeydown = null;
      close(modal, resolve, result);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const result = normalizeRemote({
        host: host.value,
        user: user.value,
        port: port.value,
        remotePath: path.value,
        sessionName: session.value,
      });
      if (!result.ok) {
        error.textContent = result.error;
        error.hidden = false;
        return;
      }
      finish(result.remote);
    };
    $('#remote-cancel').onclick = () => finish(null);
    modal.onkeydown = (e) => {
      if (e.key === 'Escape') finish(null);
    };
  });
}
