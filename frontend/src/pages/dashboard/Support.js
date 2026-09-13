import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, Paperclip, HelpCircle, X, CheckCheck, Check, Clock } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';
import { useAuth } from '@/context/AuthContext';

const WhatsAppIcon = (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.966-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.626.712.226 1.36.194 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347zM12.017 2C6.503 2 2.02 6.484 2.02 12c0 1.888.5 3.66 1.371 5.19L2 22l4.902-1.362A9.955 9.955 0 0012.017 22c5.514 0 9.997-4.484 9.997-10s-4.483-10-9.997-10zm0 18.204c-1.75 0-3.408-.463-4.834-1.298l-.347-.207-3.588.997.958-3.5-.226-.359a8.15 8.15 0 01-1.256-4.34c0-4.505 3.665-8.17 8.17-8.17s8.17 3.665 8.17 8.17c0 4.506-3.665 8.17-8.17 8.17z" /></svg>);
const TelegramIcon = (p) => (<svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M9.417 15.181L9.05 20.34c.526 0 .754-.226 1.028-.497l2.464-2.357 5.106 3.74c.937.516 1.598.244 1.85-.867l3.35-15.703h.001c.297-1.386-.502-1.929-1.415-1.593L1.29 9.634c-1.353.526-1.333 1.28-.23 1.622l4.955 1.541L17.5 5.87c.542-.361 1.036-.16.63.2l-8.713 9.111z" /></svg>);

export default function Support() {
  const [config, setConfig] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [chatOpen, setChatOpen] = useState(false);
  const scrollRef = useRef();
  const fileRef = useRef();

  const loadCfg = () => api.get('/support/config').then(({ data }) => setConfig(data));
  const loadMessages = () => api.get('/support/messages').then(({ data }) => setMessages(data));

  useEffect(() => { loadCfg(); loadMessages(); }, []);
  useEffect(() => {
    if (!chatOpen) return;
    const iv = setInterval(loadMessages, 4000);
    return () => clearInterval(iv);
  }, [chatOpen]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, chatOpen]);

  const send = async (e) => {
    e?.preventDefault?.();
    if (!text.trim() && attachments.length === 0) return;
    const optimistic = { id: 'tmp-' + Date.now(), sender: 'user', text, attachments, created_at: new Date().toISOString(), status: 'sending' };
    setMessages((m) => [...m, optimistic]);
    setText(''); setAttachments([]);
    try {
      const { data } = await api.post('/support/messages', { text: optimistic.text, attachments: optimistic.attachments });
      setMessages((m) => m.map((x) => x.id === optimistic.id ? data : x));
    } catch { toast.error('Erreur d\'envoi'); loadMessages(); }
  };

  const onAttach = (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach((f) => {
      if (f.size > 2_500_000) { toast.error(`${f.name} trop volumineux (max 2.5Mo)`); return; }
      const r = new FileReader();
      r.onload = (ev) => setAttachments((a) => [...a, { name: f.name, type: f.type, data: ev.target.result }]);
      r.readAsDataURL(f);
    });
  };

  if (!config) return <div className="text-slate-500 text-sm">Chargement…</div>;

  return (
    <div className="space-y-5" data-testid="page-support">
      <div>
        <h1 className="font-cabinet text-2xl font-extrabold tracking-tighter text-slate-900">Support</h1>
        <p className="text-slate-500 text-xs mt-1">Choisissez votre canal préféré pour contacter notre équipe.</p>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        {config.chat_enabled && (
          <ChannelCard onClick={() => setChatOpen(true)} I={MessageCircle} c="bg-blue-500" title="Chat en direct" sub="Réponse en quelques minutes" testid="ch-chat" />
        )}
      </div>

      <div className="bg-white border border-slate-100 rounded-2xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <HelpCircle className="w-4 h-4 text-[#2563EB]" />
          <h2 className="font-cabinet font-bold text-slate-900 text-sm">Questions fréquentes</h2>
        </div>
        <div className="space-y-2">
          {(config.faqs || []).map((f) => (
            <details key={f.id || f.question} className="group border border-slate-100 rounded-xl p-3 open:bg-slate-50">
              <summary className="cursor-pointer font-semibold text-slate-900 text-xs list-none flex items-center justify-between">
                {f.question}<span className="text-[#2563EB] group-open:rotate-180 transition-transform text-xs">▾</span>
              </summary>
              <p className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">{f.answer}</p>
            </details>
          ))}
          {(!config.faqs || config.faqs.length === 0) && (
            <p className="text-xs text-slate-500">Aucune question fréquente n’est disponible pour le moment.</p>
          )}
        </div>
      </div>

      {/* Chat widget */}
      {chatOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-end sm:items-center justify-center sm:p-4">
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md h-[80vh] sm:h-[600px] flex flex-col shadow-2xl" data-testid="chat-widget">
            <div className="p-4 border-b border-slate-100 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white flex items-center justify-center"><MessageCircle className="w-5 h-5" /></div>
              <div className="flex-1">
                <div className="font-cabinet font-bold text-sm text-slate-900">Support Biz-transPay</div>
                <div className="text-[10px] text-emerald-600 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> En ligne</div>
              </div>
              <button onClick={() => setChatOpen(false)} className="w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center" data-testid="chat-close"><X className="w-4 h-4" /></button>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">
              {messages.length === 0 && (
                <div className="text-center text-xs text-slate-400 py-8">
                  <MessageCircle className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                  Bonjour ! Envoyez-nous un message et un agent vous répondra rapidement.
                </div>
              )}
              {messages.map((m) => (
                <Bubble key={m.id} m={m} />
              ))}
            </div>

            {attachments.length > 0 && (
              <div className="px-4 py-2 border-t border-slate-100 flex gap-2 overflow-x-auto">
                {attachments.map((a, i) => (
                  <div key={i} className="relative shrink-0">
                    {a.type.startsWith('image/') ? (
                      <img src={a.data} alt={a.name} className="w-14 h-14 rounded-lg object-cover" />
                    ) : (
                      <div className="w-14 h-14 rounded-lg bg-slate-100 flex items-center justify-center text-[9px] text-slate-500 font-bold">FILE</div>
                    )}
                    <button onClick={() => setAttachments((arr) => arr.filter((_, x) => x !== i))} className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[8px] flex items-center justify-center"><X className="w-2 h-2" /></button>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={send} className="p-3 border-t border-slate-100 flex items-center gap-2">
              <button type="button" onClick={() => fileRef.current?.click()} data-testid="chat-attach" className="w-9 h-9 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-500"><Paperclip className="w-4 h-4" /></button>
              <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" onChange={onAttach} className="hidden" />
              <input value={text} onChange={(e) => setText(e.target.value)} data-testid="chat-input" placeholder="Tapez votre message…" className="flex-1 px-3 py-2 border border-slate-200 rounded-full text-sm outline-none focus:border-[#2563EB]" />
              <button type="submit" disabled={!text.trim() && attachments.length === 0} data-testid="chat-send" className="w-9 h-9 rounded-full bg-[#2563EB] text-white flex items-center justify-center disabled:opacity-50"><Send className="w-4 h-4" /></button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function ChannelCard({ href, onClick, I, c, title, sub, testid }) {
  const props = { 'data-testid': testid, className: 'group bg-white border border-slate-100 rounded-2xl p-4 hover:border-[#2563EB] hover:-translate-y-0.5 transition-transform flex items-center gap-3 text-left w-full' };
  const inner = (
    <>
      <div className={`w-11 h-11 rounded-2xl ${c} text-white flex items-center justify-center shrink-0 shadow-lg`}><I className="w-5 h-5" /></div>
      <div className="min-w-0">
        <div className="font-cabinet font-bold text-sm text-slate-900 truncate">{title}</div>
        <div className="text-[11px] text-slate-500 truncate">{sub}</div>
      </div>
    </>
  );
  return href ? <a href={href} target="_blank" rel="noreferrer" {...props}>{inner}</a> : <button type="button" onClick={onClick} {...props}>{inner}</button>;
}

function Bubble({ m }) {
  const isUser = m.sender === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] ${isUser ? 'bg-[#2563EB] text-white' : 'bg-white text-slate-900 border border-slate-100'} rounded-2xl px-3 py-2 shadow-sm`}>
        {m.attachments?.map((a, i) => (
          <div key={i} className="mb-1">
            {(a.type || '').startsWith('image/') ? (
              <img src={a.data} alt={a.name} className="rounded-lg max-w-full" />
            ) : (
              <a href={a.data} download={a.name} className="text-xs underline">{a.name}</a>
            )}
          </div>
        ))}
        {m.text && <div className="text-sm whitespace-pre-wrap break-words">{m.text}</div>}
        <div className={`text-[9px] mt-0.5 flex items-center gap-1 justify-end ${isUser ? 'text-white/70' : 'text-slate-400'}`}>
          {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          {isUser && (m.status === 'sending' ? <Clock className="w-3 h-3" /> : m.read_by_admin ? <CheckCheck className="w-3 h-3" /> : <Check className="w-3 h-3" />)}
        </div>
      </div>
    </div>
  );
}
