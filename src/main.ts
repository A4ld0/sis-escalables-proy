import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Config, decode, Pending, queue, Session } from './session';

interface Person { uid: string; username: string; displayName: string; status: string; avatarUrl: string; lastSeenAt?: string; online?: boolean; role?: string; relationship?: string; lastReadSeq?: number; lastDeliveredSeq?: number; }
interface Conversation { cid: string; name: string; type: 'direct'|'group'; role: string; unread: number; }
interface Message { seq: number; senderId?: string; text?: string; createdAt?: string; hidden?: boolean; }

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
  private syncing = false;
  private generation = 0;
  private last = 0;
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
      await Promise.all([this.inbox(),this.refreshContacts(),this.refreshQueue(),this.refreshBlocks()]);
      const cid = new URLSearchParams(location.search).get('chat');
      if (cid) {
        const found = this.conversations().find(c => c.cid === cid);
        if (found) await this.select(found);
      }
      void this.connect();
      this.timer = setInterval(() => void (async () => {
        await this.flush();
        await Promise.all([this.sync(),this.inbox()]);
      })().catch(() => {}),8000);
    });
  }
  ngOnDestroy() {
    this.destroyed = true;
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
  logout() { this.session!.logout(); }
  private async connect() {
    if (this.destroyed) return;
    try {
      const {ticket,expires} = await this.session!.api<{ticket:string;expires:number}>('/socket','POST');
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
        void this.run(async () => { await this.flush(); await this.sync(); });
      };
      ws.onclose = () => { clearInterval(this.heartbeat); this.connected.set(false); this.scheduleReconnect(); };
      ws.onmessage = event => {
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
        if (data.kind === 'message' && data.cid === this.selected()?.cid) {
          if (data.seq === this.last+1 && !this.syncing) {
            this.last = data.seq;
            this.merge([data]);
            void this.run(() => this.receipts(data.cid,data.seq));
          } else if (data.seq > this.last) void this.run(() => this.sync());
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
      const generation = ++this.generation;
      this.selected.set(c);
      this.messages.set([]);
      this.members.set([]);
      this.older.set(false);
      this.typing.set(false);
      this.last = 0;
      const [page,members] = await Promise.all([
        this.session!.api<{items:Message[];cursor?:string}>('/conversations/'+c.cid+'/messages'),
        this.session!.api<Person[]>('/conversations/'+c.cid+'/members'),
      ]);
      if (generation !== this.generation) return;
      this.merge(page.items);
      this.last = Math.max(this.last,...page.items.map(m=>m.seq),0);
      this.members.set(members);
      this.older.set(Boolean(page.cursor));
      await this.receipts(c.cid,this.last);
    });
  }
  loadOlder() {
    return this.run(async () => {
      const c = this.selected();
      const seq = this.messages()[0]?.seq;
      if (!c || !seq) return;
      const page = await this.session!.api<{items:Message[];cursor?:string}>('/conversations/'+c.cid+'/messages?beforeSeq='+seq);
      if (this.selected()?.cid !== c.cid) return;
      this.merge(page.items);
      this.older.set(Boolean(page.cursor));
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
    const c = this.selected();
    if (!c || this.syncing) return;
    const generation = this.generation;
    this.syncing = true;
    try {
      let page;
      do {
        page = await this.session!.api<{items:Message[];cursor?:string}>('/conversations/'+c.cid+'/messages?afterSeq='+this.last);
        if (generation !== this.generation) return;
        this.merge(page.items);
        this.last = Math.max(this.last,...page.items.map(m=>m.seq));
      } while (page.cursor && page.items.length);
      const members = await this.session!.api<Person[]>('/conversations/'+c.cid+'/members');
      if (generation !== this.generation) return;
      this.members.set(members);
      await this.receipts(c.cid,this.last);
    } finally { this.syncing = false; }
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
      this.selected.set(null);
      this.conversations.set([]);
      this.inboxPaged = false;
      await this.inbox();
    });
  }
  block(person: Person, unblock = false) {
    return this.run(async () => {
      await this.session!.api('/blocks/'+person.uid,unblock?'DELETE':'POST');
      await Promise.all([this.refreshBlocks(),this.refreshContacts()]);
      this.notice.set(unblock?'Usuario desbloqueado.':'Usuario bloqueado.');
      const c = this.selected();
      if (c) await this.select(c);
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
      for (const item of this.outbox()) await queue('readwrite',store=>store.delete(item.clientMessageId));
      this.logout();
    });
  }
}
bootstrapApplication(Chat).catch(console.error);








