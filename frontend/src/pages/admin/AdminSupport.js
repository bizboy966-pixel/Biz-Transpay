import { useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, Save, Paperclip, X, CheckCheck, Check, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/api';

export default function AdminSupport() {
  const [cfg, setCfg] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [convs, setConvs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const scrollRef = useRef();

  const loadCfg = () => api.get('/admin/support/config').then(({ data }) => setCfg(data));
  const loadConvs = () => api.get('/admin/support/conversations').then(({ data }) => setConvs(data));

  useEffect(() => { loadCfg(); loadConvs(); }, []);
  useEffect(() => {
    const iv = setInterval(loadConvs, 5000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!selected) return;
    api.get(`/admin/support/conversations/${selected.conversation_id}/messages`).then(({ data }) => setMessages(data));
    const iv = setInterval(() => {
      api.get(`/admin/support/conversations/${selected.conversation_id}/messages`).then(({ data }) => setMessages(data));
    }, 4000);
    return () => clearInterval(iv);
  }, [selected]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  const saveCfg = async () => {
    try {
      await api.patch('/admin/support/config', {
        chat_enabled: cfg.chat_enabled,
        faqs: cfg.faqs || [],
      });
      toast.success('Configuration enregistrée');
      setDirty(false);
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim() || !selected) return;
    try {
      await api.post(`/admin/support/conversations/${selected.conversation_id}/messages`, { text });
      setText('');
      api.get(`/admin/support/conversations/${selected.conversation_id}/messages`).then(({ data }) => setMessages(data));
      loadConvs();
    } catch (err) { toast.error(err.response?.data?.detail || 'Erreur'); }
  };

  if (!cfg) return <div className="text-slate-500 text-sm">Chargement…</div>;

  return (
    <div className="space-y-5" data-testid="admin-support-page">
      {/* Config */}
      <div className="bg-white border border-slate-100 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-cabinet font-bold text-slate-900">Configuration des canaux</h2>
            <p className="text-xs text-slate-500 mt-0.5">Paramètres visibles côté utilisateur sur la page Support.</p>
          </div>
          <button onClick={saveCfg} disabled={!dirty} data-testid="btn-save-support-config" className="inline-flex items-center gap-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold px-4 py-2 rounded-full text-xs disabled:opacity-50">
            <Save className="w-3.5 h-3.5" /> Enregistrer
          </button>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <label className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl cursor-pointer">
            <input type="checkbox" checked={cfg.chat_enabled} onChange={(e) => { setCfg({ ...cfg, chat_enabled: e.target.checked }); setDirty(true); }} data-testid="cfg-chat-enabled" className="w-4 h-4 accent-[#2563EB]" />
            <div>
              <div className="font-cabinet font-bold text-xs text-slate-900">Chat en direct</div>
              <div className="text-[10px] text-slate-500">Messagerie interne Biz-transPay</div>
            </div>
          </label>
        </div>

        <div className="mt-5 pt-5 border-t border-slate-100" data-testid="support-faq-editor">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-cabinet font-bold text-sm text-slate-900">Questions fréquentes</h3>
              <p className="text-[11px] text-slate-500">Ces questions et réponses sont celles affichées aux utilisateurs.</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setCfg({ ...cfg, faqs: [...(cfg.faqs || []), { id: `faq-${Date.now()}`, question: '', answer: '', active: true }] });
                setDirty(true);
              }}
              data-testid="btn-add-faq"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue-50 text-[#2563EB] text-xs font-bold"
            >
              <Plus className="w-3.5 h-3.5" /> Ajouter
            </button>
          </div>
          <div className="space-y-3">
            {(cfg.faqs || []).map((faq, index) => (
              <div key={faq.id || index} className="border border-slate-200 rounded-xl p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-bold text-slate-400">FAQ {index + 1}</span>
                  <label className="ml-auto flex items-center gap-1.5 text-[10px] text-slate-500">
                    <input
                      type="checkbox"
                      checked={faq.active !== false}
                      onChange={(e) => {
                        const faqs = [...(cfg.faqs || [])];
                        faqs[index] = { ...faqs[index], active: e.target.checked };
                        setCfg({ ...cfg, faqs }); setDirty(true);
                      }}
                      data-testid={`faq-active-${index}`}
                      className="w-3.5 h-3.5 accent-[#2563EB]"
                    />
                    Visible
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setCfg({ ...cfg, faqs: (cfg.faqs || []).filter((_, i) => i !== index) });
                      setDirty(true);
                    }}
                    data-testid={`btn-delete-faq-${index}`}
                    className="text-red-500 hover:text-red-700 p-1"
                    aria-label="Supprimer cette FAQ"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <input
                  value={faq.question || ''}
                  onChange={(e) => {
                    const faqs = [...(cfg.faqs || [])];
                    faqs[index] = { ...faqs[index], question: e.target.value };
                    setCfg({ ...cfg, faqs }); setDirty(true);
                  }}
                  data-testid={`faq-question-${index}`}
                  placeholder="Question"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg outline-none focus:border-[#2563EB] text-xs font-semibold"
                />
                <textarea
                  value={faq.answer || ''}
                  onChange={(e) => {
                    const faqs = [...(cfg.faqs || [])];
                    faqs[index] = { ...faqs[index], answer: e.target.value };
                    setCfg({ ...cfg, faqs }); setDirty(true);
                  }}
                  data-testid={`faq-answer-${index}`}
                  placeholder="Réponse affichée à l'utilisateur"
                  rows={3}
                  className="mt-2 w-full px-3 py-2 border border-slate-200 rounded-lg outline-none focus:border-[#2563EB] text-xs resize-y"
                />
              </div>
            ))}
            {(!cfg.faqs || cfg.faqs.length === 0) && (
              <p className="text-xs text-slate-400 border border-dashed border-slate-200 rounded-xl p-4 text-center">Aucune FAQ configurée.</p>
            )}
          </div>
        </div>
      </div>

      {/* Conversations */}
      <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden" data-testid="conversations-panel">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="font-cabinet font-bold text-slate-900">Conversations Live Chat</h2>
            <p className="text-xs text-slate-500 mt-0.5">{convs.length} conversation{convs.length > 1 ? 's' : ''}</p>
          </div>
        </div>

        <div className="grid md:grid-cols-[280px_1fr] min-h-[420px]">
          <div className="border-r border-slate-100 max-h-[520px] overflow-y-auto">
            {convs.length === 0 && <div className="p-8 text-center text-xs text-slate-400">Aucune conversation.</div>}
            {convs.map((c) => (
              <button
                key={c.conversation_id}
                onClick={() => setSelected(c)}
                data-testid={`conv-${c.conversation_id}`}
                className={`w-full text-left p-3 border-b border-slate-50 hover:bg-slate-50/70 flex items-start gap-2.5 ${selected?.conversation_id === c.conversation_id ? 'bg-blue-50/70' : ''}`}
              >
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white flex items-center justify-center text-xs font-bold shrink-0">{c.user?.full_name?.[0]?.toUpperCase() || 'U'}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-semibold text-xs text-slate-900 truncate">{c.user?.full_name || c.user?.username}</div>
                    {c.unread_count > 0 && <span className="ml-auto shrink-0 w-4 h-4 rounded-full bg-[#2563EB] text-white text-[9px] font-bold flex items-center justify-center">{c.unread_count}</span>}
                  </div>
                   <div className="text-[10px] text-slate-500 truncate">{c.last_sender === 'admin' ? 'Vous : ' : ''}{c.last_message || 'Pièce jointe'}</div>
                  <div className="text-[9px] text-slate-400">{new Date(c.last_created).toLocaleString()}</div>
                </div>
              </button>
            ))}
          </div>

          {selected ? (
            <div className="flex flex-col h-[520px]">
              <div className="p-3 border-b border-slate-100 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#3B82F6] to-[#1D4ED8] text-white flex items-center justify-center text-xs font-bold">{selected.user?.full_name?.[0]?.toUpperCase()}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-cabinet font-bold text-sm text-slate-900 truncate">{selected.user?.full_name}</div>
                  <div className="text-[10px] text-slate-500 truncate">@{selected.user?.username} · {selected.user?.email}</div>
                </div>
              </div>
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.sender === 'admin' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] ${m.sender === 'admin' ? 'bg-[#2563EB] text-white' : 'bg-white text-slate-900 border border-slate-100'} rounded-2xl px-3 py-2 shadow-sm`}>
                      {m.attachments?.map((a, i) => (
                        <div key={i} className="mb-1">{(a.type || '').startsWith('image/') ? <img src={a.data} alt="" className="rounded-lg max-w-full" /> : <a href={a.data} className="text-xs underline">{a.name}</a>}</div>
                      ))}
                      {m.text && <div className="text-sm whitespace-pre-wrap break-words">{m.text}</div>}
                      <div className={`text-[9px] mt-0.5 flex items-center gap-1 justify-end ${m.sender === 'admin' ? 'text-white/70' : 'text-slate-400'}`}>
                        {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {m.sender === 'admin' && (m.read_by_user ? <CheckCheck className="w-3 h-3" /> : <Check className="w-3 h-3" />)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <form onSubmit={send} className="p-3 border-t border-slate-100 flex items-center gap-2">
                <input value={text} onChange={(e) => setText(e.target.value)} data-testid="admin-chat-input" placeholder="Répondre…" className="flex-1 px-3 py-2 border border-slate-200 rounded-full text-sm outline-none focus:border-[#2563EB]" />
                <button type="submit" disabled={!text.trim()} data-testid="admin-chat-send" className="w-9 h-9 rounded-full bg-[#2563EB] text-white flex items-center justify-center disabled:opacity-50"><Send className="w-4 h-4" /></button>
              </form>
            </div>
          ) : (
            <div className="flex items-center justify-center text-xs text-slate-400 p-8">Sélectionnez une conversation pour répondre.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, tid, placeholder }) {
  return (
    <div>
      <label className="text-xs font-semibold text-slate-700 mb-1.5 block">{label}</label>
      <input data-testid={tid} value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl outline-none focus:border-[#2563EB] text-sm" />
    </div>
  );
}
