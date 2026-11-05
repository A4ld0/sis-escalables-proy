export interface Config {
  http: string; ws: string; login: string; clientId: string; redirect: string; vapidPublicKey: string; digest: boolean; presence: boolean;
}
interface Tokens { id_token: string; access_token: string; refresh_token?: string; }
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export function decode(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'=')), c => c.charCodeAt(0));
}
export class Session {
  tokens: Tokens | undefined = JSON.parse(sessionStorage.getItem('tokens') ?? 'null') ?? undefined;
  private refresh?: Promise<void>;
  constructor(readonly config: Config) {}
  async login(signup = false) {
    const verifier = encode(crypto.getRandomValues(new Uint8Array(48)));
    const state = crypto.randomUUID();
    sessionStorage.setItem('oauth',JSON.stringify({verifier,state}));
    const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    const params = new URLSearchParams({client_id:this.config.clientId,response_type:'code',redirect_uri:this.config.redirect,
      scope:'openid email profile',state,code_challenge:challenge,code_challenge_method:'S256'});
    location.assign(this.config.login+(signup?'/signup?':'/oauth2/authorize?')+params);
  }
  async callback() {
    const params = new URLSearchParams(location.search);
    if (!params.has('code') && !params.has('error')) return;
    history.replaceState(null,'',location.pathname);
    const pending = JSON.parse(sessionStorage.getItem('oauth') ?? 'null');
    sessionStorage.removeItem('oauth');
    if (!pending || params.get('state') !== pending.state || !params.has('code')) throw new Error('No se pudo completar el inicio de sesión.');
    await this.exchange({grant_type:'authorization_code',code:params.get('code')!,code_verifier:pending.verifier,redirect_uri:this.config.redirect});
  }
  private async exchange(fields: Record<string,string>) {
    const result = await fetch(this.config.login+'/oauth2/token',{method:'POST',body:new URLSearchParams({client_id:this.config.clientId,...fields})});
    if (!result.ok) throw new Error('La sesión terminó. Vuelve a iniciar sesión.');
    const next = await result.json() as Tokens;
    this.tokens = {...next,refresh_token:next.refresh_token ?? this.tokens?.refresh_token};
    sessionStorage.setItem('tokens',JSON.stringify(this.tokens));
  }
  async token() {
    if (!this.tokens) throw new Error('Inicia sesión.');
    const claims = JSON.parse(new TextDecoder().decode(decode(this.tokens.id_token.split('.')[1])));
    if (claims.exp*1000 < Date.now()+60000) {
      const refresh_token = this.tokens.refresh_token;
      if (!refresh_token) throw new Error('La sesión terminó.');
      this.refresh ??= this.exchange({grant_type:'refresh_token',refresh_token}).finally(() => { this.refresh = undefined; });
      await this.refresh;
    }
    return this.tokens.id_token;
  }
  logout() {
    this.tokens = undefined;
    sessionStorage.removeItem('tokens');
    location.assign(this.config.login+'/logout?'+new URLSearchParams({client_id:this.config.clientId,logout_uri:this.config.redirect}));
  }
  async api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const result = await fetch(this.config.http+'/v1'+path,{method,headers:{Authorization:'Bearer '+await this.token(),
      ...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    const data = await result.json();
    if (!result.ok) throw new Error(data.error ?? 'No se pudo completar la solicitud.');
    return data;
  }
}
export interface Pending { uid: string; cid: string; text: string; clientMessageId: string; }
const openQueue = () => new Promise<IDBDatabase>((resolve,reject) => {
  const request = indexedDB.open('chat-outbox',1);
  request.onupgradeneeded = () => request.result.createObjectStore('pending',{keyPath:'clientMessageId'});
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
export async function queue<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openQueue();
  try {
    return await new Promise<T>((resolve,reject) => {
      const tx = db.transaction('pending',mode);
      const request = fn(tx.objectStore('pending'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

