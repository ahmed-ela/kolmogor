import { connect } from 'node:net';

const publicErrors = new Map([
  ['This server has reached its workspace capacity.', 503],
  ['Start a new sign-in.', 409],
  ['Invalid authorization code.', 400],
  ['The provider could not start sign-in.', 502],
]);
export class WorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.status = publicErrors.get(message);
  }
}

export function workspaceBroker(path) {
  function request(workspace, action, provider, code, turn, onDelta) {
    const socket = connect(path);
    socket.on('connect', () =>
      socket.write(JSON.stringify({ workspace, action, provider, code, turn }) + '\n')
    );
    return new Promise((resolve, reject) => {
      const maxBytes = action === 'chat' ? 640 * 1024 : action === 'chat-models' ? 256 * 1024 : 8192;
      let response = Buffer.alloc(0);
      const fail = () => {
        finish();
        socket.destroy();
        reject(Error('Workspace service unavailable'));
      };
      const timeout = setTimeout(fail, 150_000);
      const finish = () => {
        clearTimeout(timeout);
        socket.off('error', fail);
        socket.off('end', fail);
        socket.off('data', read);
      };
      function read(chunk) {
        response = Buffer.concat([response, chunk]);
        try {
          let newline;
          let data;
          while ((newline = response.indexOf(10)) >= 0) {
            if (newline > maxBytes) throw Error('Invalid broker response');
            data = JSON.parse(response.subarray(0, newline).toString());
            response = response.subarray(newline + 1);
            if (action !== 'chat' || !Object.hasOwn(data, 'delta')) break;
            if (typeof data.delta !== 'string') throw Error('Invalid chat delta');
            onDelta(data.delta);
            data = undefined;
          }
          if (data === undefined) {
            if (response.length > maxBytes) throw Error('Invalid broker response');
            return;
          }
          finish();
          if (publicErrors.has(data.error)) throw new WorkspaceError(data.error);
          if (data.error) throw Error('Workspace operation failed');
          if (action === 'display') {
            if (data.display !== true) throw Error('Display unavailable');
            socket.pause();
            if (response.length) socket.unshift(response);
            resolve(socket);
          } else {
            socket.end();
            resolve(data);
          }
        } catch (err) {
          finish();
          socket.destroy();
          reject(err);
        }
      }
      socket.on('error', fail);
      socket.on('end', fail);
      socket.on('data', read);
    });
  }
  return { call: request, chat: (workspace, turn, onDelta) => request(workspace, 'chat', undefined, undefined, turn, onDelta), display: (workspace) => request(workspace, 'display') };
}
