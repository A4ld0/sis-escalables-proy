import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ApiError, Config, decode, Pending, queue, Session } from './session';
import { clearHistory, Message, readHistory, recentMessageLimit, SavedHistory, writeHistory } from './history';

interface Person { uid: string; username: string; displayName: string; status: string; avatarUrl: string; lastSeenAt?: string; online?: boolean; role?: string; relationship?: string; lastReadSeq?: number; lastDeliveredSeq?: number; }
interface Conversation { cid: string; name: string; type: 'direct'|'group'; role: string; unread: number; cacheVersion?: string; }
interface HistoryPage { items: Message[]; cursor?: string; cacheVersion?: string; reset?: boolean; }
interface OpenHistory { cid: string; syncing: boolean; lastSeq?: number; version?: string; cached?: SavedHistory; savedVersion?: string; pendingSeq?: number; }

@Component({
  selector:'chat-root', imports:[FormsModule,DatePipe], templateUrl:'./chat.html',
})
class Chat implements OnInit, OnDestroy {
  readonly error = signal('');
  readonly notice = signal('');
  readonly ready = signal(false);
  readonly connected = signal(false);
  readonly profile = signal<Person | null>(null);
  readonly conversations = signal<Conversation[]>([]);
  readonly contacts = signal<Person[]>([]);
  readonly blocked = signal<Person[]>([]);
  readonly results = signal<Person[]>([]);
  readonly selected = signal<Conversation | null>(null);
  readonly members = signal<Person[]>([]);
  readonly messages = signal<Message[]>([]);
  readonly outbox = signal<Pending[]>([]);
  readonly typing = signal(false);
  readonly older = signal(false);
  readonly moreInbox = signal(false);
  session?: Session;
  search = '';
  groupName = '';
  text = '';
  reportReason = '';
  editName = '';
  editStatus = '';
  editAvatar = '';
  private ws?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setInterval>;
  private typingTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private attempts = 0;
  private expires?: ReturnType<typeof setTimeout>;
  private flushing = false;
  private history?: OpenHistory;
  private cursor?: string;
  private inboxPaged = false;
  private destroyed = false;
  get push() { return Boolean(this.session?.config.vapidPublicKey); }
  get digest() { return Boolean(this.session?.config.digest); }
  async ngOnInit() {
    await this.run(async () => {
      const response = await fetch('/config.json',{cache:'no-store'});
      if (!response.ok) throw new Error('Falta la configuración del entorno.');
      const config = await response.json() as Config;
      this.session = new Session(config);
      this.ready.set(true);
      await this.session.callback();
      if (!this.session.tokens) return;
      const me = await this.session.api<Person>('/users/me');
      this.profile.set(me);
      this.editName = me.displayName;
      this.editStatus = me.status;
      this.editAvatar = me.avatarUrl;
      await Promise.all([this.inbox(),this.refreshContacts(),this.refreshQueue().catch(() => {}),this.refreshBlocks()]);
      const cid = new URLSearchParams(location.search).get('chat');
      if (cid) {
        await this.run(async () => {
          try {
            const conversation = this.conversations().find(c => c.cid === cid)
              ?? await this.session!.api<Conversation>('/conversations/'+encodeURIComponent(cid));
            await this.select(conversation);
          } catch (error) {
            if (error instanceof ApiError && [401,403,404].includes(error.status)) {
              this.rememberConversation();
              await clearHistory(me.uid,cid);
            }
            throw error;
          }
        });
      }
      void this.connect();
      this.timer = setInterval(() => void Promise.allSettled([this.flush(),this.sync(),this.inbox()]),8000);
    });
  }
  ngOnDestroy() {
    this.destroyed = true;
    this.history = undefined;
    this.ws?.close();
    clearTimeout(this.retry);
    clearTimeout(this.expires);
    clearTimeout(this.typingTimer);
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
  }
  async run(action: () => Promise<unknown>) {
    this.error.set('');
    try { await action(); }
    catch (error) { this.error.set((error as Error).message); }
  }
  login(signup = false) { return this.run(() => this.session!.login(signup)); }
  async logout() {
    const uid = this.profile()?.uid;
    this.ngOnDestroy();
    this.profile.set(null);
    this.messages.set([]);
    if (uid) await clearHistory(uid);
    this.session!.logout();
  }
  private async connect() {
    if (this.destroyed) return;
    try {
      const {ticket,expires} = await this.session!.api<{ticket:string;expires:number}>('/socket','POST');
      if (this.destroyed) return;
      const ws = new WebSocket(this.session!.config.ws+'?'+new URLSearchParams({ticket}));
      this.ws = ws;
      this.expires = setTimeout(() => ws.close(),Math.max(1000,expires*1000-Date.now()-15000));
      ws.onopen = () => {
        this.connected.set(true);
        const heartbeat = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({action:'heartbeat'})); };
        if (this.session!.config.presence) {
          heartbeat();
          this.heartbeat = setInterval(heartbeat,25000);
        }
        this.attempts = 0;
        void this.run(() => Promise.all([this.flush(),this.sync()]));
      };
      ws.onclose = () => { clearInterval(this.heartbeat); this.connected.set(false); this.scheduleReconnect(); };
      ws.onmessage = event => {
        if (this.destroyed) return;
        const data = JSON.parse(event.data);
        if (data.kind === 'typing' && data.cid === this.selected()?.cid) {
          this.typing.set(true);
          clearTimeout(this.typingTimer);
          this.typingTimer = setTimeout(() => this.typing.set(false),4000);
        }
        if (data.kind === 'ack' && typeof data.clientMessageId === 'string') {
          void this.run(async () => { await queue('readwrite',s => s.delete(data.clientMessageId)); await this.refreshQueue(); await this.sync(); });
        }
        if (data.kind === 'message' && data.cid !== this.selected()?.cid) {
          void this.session!.api('/conversations/'+data.cid+'/delivered','POST',{seq:data.seq}).catch(() => {});
        }
        const history = this.history;
        if (data.kind === 'message' && history && data.cid === history.cid) {
          if (history.syncing) {
            history.pendingSeq = Math.max(history.pendingSeq ?? 0,data.seq);
          } else if (history.lastSeq !== undefined && data.seq === history.lastSeq+1) {
            history.lastSeq = data.seq;
            this.merge([data]);
            void this.persistHistory(history);
            void this.run(() => this.receipts(data.cid,data.seq));
          } else if (data.seq > (history.lastSeq ?? 0)) void this.run(() => this.sync());
        }
      };
    } catch { this.scheduleReconnect(); }
  }
  private scheduleReconnect() {
    if (this.destroyed) return;
    clearTimeout(this.retry);
    clearTimeout(this.expires);
    this.retry = setTimeout(() => void this.connect(),Math.random()*Math.min(30000,1000*2**Math.min(++this.attempts,5)));
  }
  async inbox(more = false) {

    const data = await this.session!.api<{items:Conversation[];cursor?:string}>('/conversations'+(more?'?cursor='+encodeURIComponent(this.cursor??''):''));
    const prior = this.conversations();
    if (more || !this.inboxPaged) {
      this.cursor = data.cursor;
      this.moreInbox.set(data.cursor !== undefined);
    }
    if (more) this.inboxPaged = true;
    this.conversations.set(more
      ? [...prior,...data.items.filter(item => !prior.some(c=>c.cid===item.cid))]
      : [...data.items,...(this.inboxPaged ? prior.slice(30).filter(item => !data.items.some(c=>c.cid===item.cid)) : [])]);
    const selected = this.selected();
    if (selected) {
      const latest = this.conversations().find(c=>c.cid===selected.cid);
      if (latest) this.selected.set(latest);
    }
  }
  loadInbox() { return this.run(() => this.inbox(true)); }
  loadContacts() { return this.run(() => this.refreshContacts()); }
  refreshContacts() { return this.session!.api<Person[]>('/contacts').then(data => this.contacts.set(data)); }
  private refreshBlocks() { return this.session!.api<Person[]>('/blocks').then(data => this.blocked.set(data)); }
  find() { return this.run(async () => this.results.set(await this.session!.api('/users/search?q='+encodeURIComponent(this.search)))); }
  invite(person: Person) { return this.run(async () => { await this.session!.api('/contacts/'+person.uid,'POST'); await this.refreshContacts(); }); }
  newConversation(person?: Person) {
    return this.run(async () => {
      const {cid,conversation} = await this.session!.api('/conversations','POST',person?{type:'direct',peer:person.uid}:{type:'group',name:this.groupName});
      this.groupName = '';
      await this.inbox();
      const found = this.conversations().find(item=>item.cid===cid);
      if (found || conversation) await this.select(found ?? conversation);
    });
  }
  select(c: Conversation) {
    return this.run(async () => {
      const history: OpenHistory = {cid:c.cid,syncing:true};
      this.history = history;
      this.selected.set(c);
      this.rememberConversation(c.cid);
      this.messages.set([]);
      this.members.set([]);
      this.older.set(false);
      this.typing.set(false);
      const uid = this.profile()?.uid;
      if (uid) history.cached = await readHistory(uid,c.cid);
      if (this.history !== history) return;
      history.savedVersion = history.cached?.version;
      if (history.cached && this.selected()?.cacheVersion === history.cached.version) {
        this.restoreHistory(history,history.cached);
      }
      history.syncing = false;
      await this.sync();
    });
  }
  private rememberConversation(cid?: string) {
    const url = new URL(location.href);
    if (cid) url.searchParams.set('chat',cid);
    else url.searchParams.delete('chat');
    if (url.href !== location.href) window.history.replaceState(window.history.state,'',url);
  }
  private restoreHistory(history: OpenHistory, cached: SavedHistory) {
    this.messages.set(cached.messages);
    this.older.set(cached.older);
    history.lastSeq = cached.lastSeq;
    history.version = cached.version;
    history.cached = undefined;
  }
  loadOlder() {
    return this.run(async () => {
      const history = this.history;
      const seq = this.messages()[0]?.seq;
      if (!history || !seq) return;
      const page = await this.session!.api<HistoryPage>('/conversations/'+history.cid+'/messages?beforeSeq='+seq);
      if (this.history !== history || this.messages()[0]?.seq !== seq) return;
      if (page.cacheVersion !== history.version) { await this.sync(); return; }
      this.merge(page.items);
      this.older.set(Boolean(page.cursor));
      await this.persistHistory(history);
    });
  }
  private merge(incoming: Message[]) {
    this.messages.update(old => Array.from(new Map([...old,...incoming].map(message=>[message.seq,message])).values()).sort((a,b)=>a.seq-b.seq));
  }
  private async receipts(cid: string, seq: number) {
    if (!seq) return;
    await this.session!.api('/conversations/'+cid+'/delivered','POST',{seq});
    if (document.visibilityState === 'visible') await this.session!.api('/conversations/'+cid+'/read','POST',{seq});
  }
  private async sync() {
    const history = this.history;
    if (!history || history.syncing) return;
    history.syncing = true;
    history.pendingSeq = undefined;
    try {
      const path = '/conversations/'+history.cid;
      const cached = history.cached;
      let after = history.lastSeq ?? cached?.lastSeq;
      let version = history.version ?? cached?.version;
      let page: HistoryPage;
      do {
        const params = new URLSearchParams();
        if (after !== undefined) params.set('afterSeq',String(after));
        if (version) params.set('cacheVersion',version);
        page = await this.session!.api<HistoryPage>(path+'/messages'+(params.size ? '?'+params : ''));
        if (this.history !== history) return;
        if (version && version !== page.cacheVersion && !page.reset) {
          // A server without cache validation must supply a fresh history window.
          page = await this.session!.api<HistoryPage>(path+'/messages');
          if (this.history !== history) return;
          after = undefined;
        }
        const latestPage = after === undefined || page.reset;
        if (latestPage) {
          this.messages.set([]);
          this.older.set(Boolean(page.cursor));
          after = 0;
        } else if (history.cached) {
          this.restoreHistory(history,history.cached);
        }
        history.cached = undefined;
        this.merge(page.items);
        after = Math.max(after ?? 0,...page.items.map(m=>m.seq));
        history.lastSeq = after;
        version = history.version = page.cacheVersion;
        if (latestPage || page.items.length) await this.persistHistory(history);
        if (this.history !== history) return;
        if (latestPage) break;
      } while (page.cursor && page.items.length);
      const members = await this.session!.api<Person[]>(path+'/members');
      if (this.history !== history) return;
      this.members.set(members);
      await this.receipts(history.cid,after ?? 0);
    } catch (error) {
      if (this.history !== history) return;
      if (error instanceof ApiError && [401,403,404].includes(error.status)) {
        this.history = undefined;
        this.selected.set(null);
        this.messages.set([]);
        this.rememberConversation();
        const uid = this.profile()?.uid;
        if (uid) await clearHistory(uid,history.cid);
      }
      throw error;
    } finally { history.syncing = false; }
    if (this.history === history && (history.pendingSeq ?? 0) > (history.lastSeq ?? 0)) await this.sync();
  }
  private async persistHistory(history: OpenHistory) {
    const uid = this.profile()?.uid;
    if (this.history !== history || !uid || !history.version || history.lastSeq === undefined) return;
    const messages = this.messages();
    const recent = messages.slice(-recentMessageLimit).map(({seq,senderId,text,createdAt,hidden}) => (
      {seq,senderId,text,createdAt,hidden}
    ));
    const saved = await writeHistory(uid,history.cid,{
      messages:recent,lastSeq:history.lastSeq,older:this.older() || messages.length > recent.length,version:history.version,
    },history.savedVersion);
    if (saved) history.savedVersion = saved;
  }
  private refreshQueue() {
    return queue('readonly',store=>store.getAll()).then(items => this.outbox.set((items as Pending[]).filter(x=>x.uid===this.profile()?.uid)));
  }
  send() {
    return this.run(async () => {
      const c = this.selected(), me = this.profile(), text = this.text.trim();
      if (!c || !me || !text) return;
      const item: Pending = {uid:me.uid,cid:c.cid,text,clientMessageId:crypto.randomUUID()};
      await queue('readwrite',store=>store.put(item));
      this.text = '';
      await this.refreshQueue();
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({action:'sendMessage',...item}));
      else await this.flush();
    });
  }
  private async flush() {
    if (this.flushing || !navigator.onLine) return;
    this.flushing = true;
    try {
      let failure: unknown;
      for (const item of this.outbox()) {
        try {
          await this.session!.api('/conversations/'+item.cid+'/messages','POST',item);
          await queue('readwrite',store=>store.delete(item.clientMessageId));
        } catch (error) {
          failure ??= error;
          if (!navigator.onLine) break;
        }
      }
      if (failure) throw failure;
    } finally { this.flushing = false; await this.refreshQueue(); }
  }
  discard(item: Pending) { return this.run(async () => { await queue('readwrite',store=>store.delete(item.clientMessageId)); await this.refreshQueue(); }); }
  typingEvent() {
    if (this.ws?.readyState === WebSocket.OPEN && this.selected()) this.ws.send(JSON.stringify({action:'typing',cid:this.selected()!.cid}));
  }
  label(c: Conversation) {
    if (c.name) return c.name;
    const peer = this.selected()?.cid===c.cid ? this.members().find(x=>x.uid!==this.profile()?.uid) : undefined;
    return peer?.displayName ?? 'Chat individual · '+c.cid.slice(0,6);
  }
  sender(message: Message) { return this.members().find(x=>x.uid===message.senderId)?.displayName ?? 'Usuario'; }
  delivery(message: Message) {
    const peers = this.members().filter(m=>m.uid!==this.profile()?.uid);
    if (peers.length && peers.every(p=>(p.lastReadSeq??0)>=message.seq)) return 'Leído';
    if (peers.length && peers.every(p=>(p.lastDeliveredSeq??0)>=message.seq)) return 'Entregado';
    return 'Enviado';
  }
  add(person: Person, role: string) {
    return this.run(async () => {
      const c = this.selected()!;
      await this.session!.api('/conversations/'+c.cid+'/members','POST',{uid:person.uid,role});
      await this.select(c);
    });
  }
  transfer(person: Person) {
    return this.run(async () => {
      const c = this.selected()!;
      await this.session!.api('/conversations/'+c.cid+'/owner','PUT',{uid:person.uid});
      await this.inbox();
      await this.select({...c,role:'admin'});
    });
  }
  moderate(remove: boolean) {
    return this.run(async () => {
      const c = this.selected()!;
      if (!confirm(remove?'¿Eliminar el grupo?':'¿Salir de la conversación?')) return;
      await this.session!.api('/conversations/'+c.cid+(remove?'':'/members/me'),'DELETE');
      if (this.history?.cid === c.cid) {
        this.history = undefined;
        this.selected.set(null);
        this.messages.set([]);
        this.rememberConversation();
      }
      const uid = this.profile()?.uid;
      if (uid) await clearHistory(uid,c.cid);
      this.conversations.set([]);
      this.inboxPaged = false;
      await this.inbox();
    });
  }
  block(person: Person, unblock = false) {
    return this.run(async () => {
      await this.session!.api('/blocks/'+person.uid,unblock?'DELETE':'POST');
      this.conversations.update(items => items.map(item => ({...item,cacheVersion:undefined})));
      const c = this.selected();
      await Promise.all([
        c ? this.select({...c,cacheVersion:undefined}) : undefined,
        this.refreshBlocks(),this.refreshContacts(),this.inbox(),
      ]);
      this.notice.set(unblock?'Usuario desbloqueado.':'Usuario bloqueado.');
    });
  }
  report() {
    return this.run(async () => {
      await this.session!.api('/reports','POST',{cid:this.selected()!.cid,reason:this.reportReason});
      this.reportReason = '';
      this.notice.set('Reporte guardado.');
    });
  }
  saveProfile() {
    return this.run(async () => this.profile.set(await this.session!.api('/users/me','PATCH',{displayName:this.editName,status:this.editStatus,avatarUrl:this.editAvatar})));
  }
  enablePush() {
    return this.run(async () => {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const ready = await navigator.serviceWorker.ready;
      const subscription = await ready.pushManager.getSubscription() ?? await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decode(this.session!.config.vapidPublicKey)});
      const deviceId = localStorage.getItem('deviceId') ?? crypto.randomUUID();
      localStorage.setItem('deviceId',deviceId);
      await this.session!.api('/devices/'+deviceId,'PUT',subscription.toJSON());
      this.notice.set('Notificaciones activadas.');
    });
  }
  setDigest(digest: boolean) { return this.run(async () => { await this.session!.api('/account/notifications','PUT',{digest}); this.notice.set('Preferencia guardada.'); }); }
  exportData() {
    return this.run(async () => {
      const items = [];
      let cursor: string | undefined;
      do {
        const page: {items:any[];cursor?:string} = await this.session!.api('/account/export'+(cursor?'?cursor='+encodeURIComponent(cursor):''));
        items.push(...page.items);
        cursor = page.cursor;
      } while (cursor);
      const url = URL.createObjectURL(new Blob([JSON.stringify({items},null,2)],{type:'application/json'}));
      const a = document.createElement('a');
      a.href = url; a.download = 'mis-datos.json'; a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
  }
  deleteAccount() {
    return this.run(async () => {
      if (!confirm('¿Solicitar el borrado de tu cuenta?')) return;
      await this.session!.api('/account','DELETE');
      try {
        for (const item of this.outbox()) await queue('readwrite',store=>store.delete(item.clientMessageId));
      } finally { await this.logout(); }
    });
  }
}
bootstrapApplication(Chat).catch(console.error);








