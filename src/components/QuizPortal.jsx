import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, CheckCircle2, Clipboard, Copy, KeyRound, LogIn, Plus, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { hasSupabase, supabase } from '../lib/supabase';

const LETTERS = ['أ', 'ب', 'ج', 'د'];
const MAX_QUESTIONS = 100;
// Turns the database / network error into a short Arabic message (never shows raw SQL errors)
const friendly = err => {
  const m = String(err?.message || err || '');
  if (m.includes('rate_limited')) return 'عدد الطلبات كبير. انتظر بضع دقائق وحاول مرة أخرى.';
  if (m.includes('capacity_reached')) return 'المنصة وصلت للحد الأقصى من الكويزات حاليًا. حاول لاحقًا.';
  if (m.includes('quiz_full')) return 'اكتمل عدد المحاولات المسموح لهذا الكويز.';
  if (/abort|timeout|timed out/i.test(m)) return 'انتهت مهلة الاتصال. تأكد من الإنترنت وحاول مرة أخرى.';
  return 'تعذر إتمام الطلب. حاول مرة أخرى.';
};
const makeCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const emptyQuestion = () => ({ question: '', answers: ['', '', '', ''], correct: 0 });
const initialQuiz = () => ({ title: '', description: '', password: '', duration: 30, questions: [emptyQuestion(), emptyQuestion(), emptyQuestion()] });

function Shell({ children, onHome }) { return <><header><button className="portal-brand" onClick={onHome}><span className="mini-logo">?</span>اختبر معلوماتك</button></header>{children}</>; }

export default function QuizPortal() {
  const [quizzes, setQuizzes] = useLocalStorage('quiz-library', []);
  const [view, setView] = useState('home');
  const [active, setActive] = useState(null);
  const [studentName, setStudentName] = useState('');
  const [results, setResults] = useLocalStorage('quiz-results', []);
  const [score, setScore] = useState(null);
  const goHome = () => { setView('home'); setActive(null); setStudentName(''); };
  const cleanQuiz = quiz => ({ ...quiz, questions: quiz.questions.map(q => ({ ...q, answers: q.answers.filter(a => a.trim()), correct: q.answers.slice(0, q.correct).filter(a => a.trim()).length })) });
  const saveQuiz = async rawQuiz => { const quiz = cleanQuiz(rawQuiz); if (hasSupabase) { const { data, error } = await supabase.rpc('create_quiz', { p_title: quiz.title, p_description: quiz.description, p_password: quiz.password, p_duration: Number(quiz.duration), p_questions: quiz.questions }); if (error) return alert(friendly(error)); const created = data?.[0]; if (!created) return alert('تعذر إنشاء الكويز'); const item = { ...quiz, id: created.id, code: created.access_code, duration: created.duration_minutes, teacherKey: created.teacher_key, createdAt: Date.now() }; setQuizzes([...quizzes, item]); setActive(item); setView('created'); return; } const item = { ...quiz, id: crypto.randomUUID?.() || Date.now().toString(), code: makeCode(), createdAt: Date.now() }; setQuizzes([...quizzes, item]); setActive(item); setView('created'); };
  const submitResult = async result => {
    if (hasSupabase) {
      const { data, error } = await supabase.rpc('submit_quiz_attempt', { p_quiz_id: result.quizId, p_student_name: result.studentName, p_answers: result.answers, p_started_at: result.startedAt });
      if (error) return friendly(error);
      setScore(data?.[0] || null);
    } else {
      const total = active.questions.length;
      const local = { ...result, total, score: result.answers.filter((a, i) => a === active.questions[i].correct).length };
      setResults([...results, local]);
      setScore({ score: local.score, total });
    }
    setView('student-result');
    return true;
  };
  const deleteQuiz = async q => {
    if (hasSupabase && q.teacherKey) {
      const { error } = await supabase.rpc('delete_quiz', { p_quiz_id: q.id, p_teacher_key: q.teacherKey });
      if (error) return alert(friendly(error));
    }
    setQuizzes(quizzes.filter(x => x.id !== q.id));
  };
  if (view === 'home') return <Home onTeacher={() => setView('teacher-create')} onStudent={() => setView('student-join')} onDashboard={() => setView('teacher-dashboard')} />;
  if (view === 'teacher-create') return <Shell onHome={goHome}><TeacherCreate onBack={goHome} onSave={saveQuiz}/></Shell>;
  if (view === 'created') return <Shell onHome={goHome}><CreatedQuiz quiz={active} onDashboard={() => setView('teacher-dashboard')} /></Shell>;
  if (view === 'teacher-dashboard') return <Shell onHome={goHome}><TeacherDashboard quizzes={quizzes} results={results} onCreate={() => setView('teacher-create')} onSelect={q => {setActive(q); setView('created')}} onDelete={deleteQuiz}/></Shell>;
  if (view === 'student-join') return <Shell onHome={goHome}><StudentJoin quizzes={quizzes} onBack={goHome} onEnter={(q,name) => {setActive(q); setStudentName(name); setView('take-quiz')}} /></Shell>;
  if (view === 'take-quiz') return <Shell onHome={goHome}><TakeQuiz quiz={active} studentName={studentName} onSubmit={submitResult}/></Shell>;
  return <Shell onHome={goHome}><StudentResult score={score} /></Shell>;
}

function Home({ onTeacher, onStudent, onDashboard }) { return <main className="portal-home"><div className="portal-hero"><div className="portal-mark"><BookOpen size={34}/></div><p className="eyebrow">منصة الاختبارات الذكية</p><h1>أنشئ اختبارك<br/><span>وابدأ التحدي</span></h1><p>اصنع امتحانك في دقائق، شارك الكود مع طلابك، وتابع النتائج بسهولة.</p></div><div className="role-grid"><button className="role-card teacher" onClick={onTeacher}><span className="role-icon"><Plus size={25}/></span><b>أنا مدرس</b><small>أنشئ كويز جديد وشارك الكود</small><ArrowRight size={18}/></button><button className="role-card student" onClick={onStudent}><span className="role-icon"><LogIn size={25}/></span><b>أنا طالب</b><small>ادخل كود الكويز وابدأ الامتحان</small><ArrowRight size={18}/></button></div><button className="outline-btn dashboard-link" onClick={onDashboard}>كويزاتي ونتائج الطلاب</button></main> }

function TeacherCreate({ onBack, onSave }) { const [quiz, setQuiz] = useState(initialQuiz); const [pdfStatus,setPdfStatus]=useState('');const [busy,setBusy]=useState(false); const update = (key,value) => setQuiz({...quiz,[key]:value}); const updateQ = (i,key,value) => setQuiz({...quiz,questions:quiz.questions.map((q,n)=>n===i?{...q,[key]:value}:q)}); const updateA=(i,j,value)=>setQuiz({...quiz,questions:quiz.questions.map((q,n)=>n===i?{...q,answers:q.answers.map((a,k)=>k===j?value:a)}:q)}); const add=()=>quiz.questions.length<MAX_QUESTIONS&&setQuiz({...quiz,questions:[...quiz.questions,emptyQuestion()]}); const remove=i=>setQuiz({...quiz,questions:quiz.questions.filter((_,n)=>n!==i)}); const loadPdf=async e=>{const file=e.target.files?.[0];if(!file)return;setPdfStatus('جاري قراءة الملف...');try{const { importQuestionsFromPdf } = await import('../utils/pdfImport');const imported=await importQuestionsFromPdf(file);setQuiz({...quiz,questions:imported});setPdfStatus(`تم استيراد ${imported.length} سؤال. راجع الإجابات قبل النشر.`)}catch(err){setPdfStatus(err.message)}}; const valid=quiz.title.trim() && quiz.password.trim() && quiz.questions.length && quiz.questions.every(q=>q.question.trim() && q.answers.filter(a=>a.trim()).length>=2 && q.answers[q.correct]?.trim()); return <main className="portal-page"><button className="text-back" onClick={onBack}><ArrowRight size={17}/> رجوع</button><div className="page-heading"><div><p className="eyebrow">لوحة المدرس</p><h1>أنشئ كويز جديد</h1></div><ShieldCheck size={32}/></div><section className="form-card"><label>اسم الكويز<input value={quiz.title} maxLength={120} onChange={e=>update('title',e.target.value)} placeholder="مثال: مراجعة الرياضيات"/></label><label>وصف مختصر<input value={quiz.description} maxLength={500} onChange={e=>update('description',e.target.value)} placeholder="اكتب وصفًا يظهر للطلاب (اختياري)"/></label><label>باسورد الدخول <input value={quiz.password} maxLength={100} onChange={e=>update('password',e.target.value)} placeholder="اكتب باسورد حقيقية للطلاب"/></label><label>مدة الامتحان بالدقائق<input type="number" min="1" max="240" value={quiz.duration} onChange={e=>update('duration',Math.min(240,Math.max(1,Number(e.target.value)||1)))} /></label><label className="pdf-upload">استيراد أسئلة من PDF<input type="file" accept="application/pdf,.pdf" onChange={loadPdf}/><small>الصيغة المدعومة: 1. السؤال ثم A) اختيار و B) اختيار</small></label>{pdfStatus&&<div className="pdf-status">{pdfStatus}</div>}</section><div className="questions-head"><h2>الأسئلة <span>{quiz.questions.length}</span></h2><button className="outline-btn" disabled={quiz.questions.length>=MAX_QUESTIONS} onClick={add}><Plus size={17}/> إضافة سؤال</button></div>{quiz.questions.map((q,i)=><section className="form-card question-form" key={i}><div className="q-title"><b>السؤال {i+1}</b>{quiz.questions.length>1&&<button className="danger-icon" onClick={()=>remove(i)}><Trash2 size={16}/></button>}</div><input className="question-input" value={q.question} onChange={e=>updateQ(i,'question',e.target.value)} placeholder="اكتب السؤال هنا..."/><div className="answer-grid">{q.answers.map((a,j)=><label key={j}><span className={q.correct===j?'answer-dot active':'answer-dot'} onClick={()=>updateQ(i,'correct',j)}>{LETTERS[j]}</span><input value={a} onChange={e=>updateA(i,j,e.target.value)} placeholder={`الاختيار ${j+1}`}/></label>)}</div><small className="hint">اضغط على الدائرة لتحديد الإجابة الصحيحة</small></section>)}<button className="primary wide-btn" disabled={!valid||busy} onClick={async()=>{setBusy(true);try{await onSave(quiz)}finally{setBusy(false)}}}>إنشاء الكويز وتوليد الكود <KeyRound size={18}/></button></main> }

function CreatedQuiz({ quiz, onDashboard }) { const [copied,setCopied]=useState(false); const copy=()=>{navigator.clipboard?.writeText(`كود الكويز: ${quiz.code}${quiz.password?`\nالباسورد: ${quiz.password}`:''}`);setCopied(true);setTimeout(()=>setCopied(false),1500)}; return <main className="created-page"><div className="success-icon"><CheckCircle2 size={40}/></div><p className="eyebrow">تم إنشاء الكويز بنجاح</p><h1>{quiz.title}</h1><p>{quiz.description || 'شارك البيانات التالية مع الطلاب لبدء الامتحان.'}</p><section className="code-card"><small>كود الدخول</small><strong>{quiz.code}</strong>{quiz.password&&<><small>الباسورد</small><b className="password-value">{quiz.password}</b></>}<button className="copy-btn" onClick={copy}>{copied?<CheckCircle2 size={17}/>:<Copy size={17}/>} {copied?'تم النسخ':'نسخ بيانات الدخول'}</button></section><button className="outline-btn" onClick={onDashboard}>الذهاب إلى لوحة التحكم</button></main> }

function TeacherDashboard({ quizzes, results, onCreate, onSelect, onDelete }) {
  const [summary, setSummary] = useState({}); // quiz id -> { attempts, avg }   (one request for the whole list)
  const [detail, setDetail] = useState({});   // quiz id -> rows                 (loaded only when a quiz is opened)
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (!hasSupabase) return undefined;
    const items = quizzes.filter(q => q.teacherKey).slice(0, 50).map(q => ({ id: q.id, key: q.teacherKey }));
    if (!items.length) return undefined;
    let cancelled = false;
    supabase.rpc('get_results_summary', { p_items: items }).then(({ data, error }) => {
      if (cancelled || error) return;
      setSummary(Object.fromEntries((data || []).map(r => [r.quiz_id, { attempts: r.attempts, avg: r.avg_percent }])));
    });
    return () => { cancelled = true; };
  }, [quizzes]);

  const toggle = async q => {
    if (openId === q.id) { setOpenId(null); return; }
    setOpenId(q.id);
    if (hasSupabase && q.teacherKey && !detail[q.id]) {
      const { data, error } = await supabase.rpc('get_quiz_results', { p_quiz_id: q.id, p_teacher_key: q.teacherKey });
      if (!error) setDetail(d => ({ ...d, [q.id]: data || [] }));
    }
  };

  return <main className="portal-page">
    <div className="page-heading"><div><p className="eyebrow">لوحة المدرس</p><h1>كويزاتي</h1></div><button className="primary" onClick={onCreate}><Plus size={17}/> كويز جديد</button></div>
    {!quizzes.length
      ? <div className="empty-state"><BookOpen size={34}/><b>لا يوجد كويزات بعد</b><span>أنشئ أول كويز وشاركه مع طلابك</span><button className="primary" onClick={onCreate}>إنشاء كويز</button></div>
      : <div className="quiz-list">{quizzes.map(q => {
          const remote = hasSupabase && q.teacherKey;
          const local = results.filter(r => r.quizId === q.id).map(r => ({ student_name: r.studentName, score: r.score, total: r.total }));
          const rows = remote ? (detail[q.id] || []) : local;
          const count = remote ? (summary[q.id]?.attempts ?? 0) : local.length;
          const avg = remote
            ? (count ? summary[q.id].avg : null)
            : (local.length ? Math.round(local.reduce((t, r) => t + (r.total ? r.score / r.total : 0), 0) / local.length * 100) : null);
          return <div key={q.id}>
            <div className="quiz-list-item">
              <div><b>{q.title}</b><small>{q.questions.length} أسئلة • الكود: <strong>{q.code}</strong>{avg !== null && <> • المتوسط {avg}%</>}</small></div>
              <span className="result-count"><Users size={15}/> {count}</span>
              <button onClick={() => toggle(q)}>النتائج</button>
              <button onClick={() => onSelect(q)}>فتح</button>
              <button className="danger-icon" onClick={() => onDelete(q)}><Trash2 size={16}/></button>
            </div>
            {openId === q.id && <div className="results-panel">{rows.length
              ? <table><thead><tr><th>الطالب</th><th>الدرجة</th><th>النسبة</th></tr></thead><tbody>{rows.map((r, i) => <tr key={i}><td>{r.student_name}</td><td>{r.score} / {r.total}</td><td>{r.total ? Math.round(r.score / r.total * 100) : 0}%</td></tr>)}</tbody></table>
              : <p>{remote && !detail[q.id] ? 'جاري التحميل...' : 'لا توجد نتائج بعد.'}</p>}</div>}
          </div>;
        })}</div>}
  </main>;
}

function StudentJoin({ quizzes, onBack, onEnter }) { const [code,setCode]=useState(''); const [password,setPassword]=useState(''); const [name,setName]=useState(''); const [error,setError]=useState(''); const [loading,setLoading]=useState(false); const enter=async()=>{if(!name.trim())return setError('اكتب اسمك أولًا');setLoading(true);setError('');if(hasSupabase){const {data,error:dbError}=await supabase.rpc('enter_quiz',{p_code:code,p_password:password});setLoading(false);if(dbError)return setError(friendly(dbError));if(!data?.length)return setError('الكود أو الباسورد غير صحيح');const q=data[0];return onEnter({...q,code:code.toUpperCase(),duration:q.duration_minutes},name.trim());}const q=quizzes.find(x=>x.code===code.trim().toUpperCase());setLoading(false);if(!q)return setError('الكود غير صحيح أو الكويز غير موجود');if(q.password!==password)return setError('الباسورد غير صحيح');onEnter(q,name.trim())};return <main className="join-page"><button className="text-back" onClick={onBack}><ArrowRight size={17}/> رجوع</button><div className="join-icon"><KeyRound size={28}/></div><p className="eyebrow">دخول الطالب</p><h1>جاهز للاختبار؟</h1><p>اكتب بيانات الدخول التي أرسلها لك المدرس.</p><section className="form-card join-form"><label>اسمك<input value={name} maxLength={80} onChange={e=>setName(e.target.value)} placeholder="اكتب اسمك"/></label><label>كود الكويز<input className="code-input" value={code} onChange={e=>{setCode(e.target.value.toUpperCase());setError('')}} placeholder="مثال: A1B2C3" maxLength={6}/></label><label>الباسورد<input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="اكتب الباسورد"/></label>{error&&<div className="error-msg"><X size={16}/>{error}</div>}<button className="primary wide-btn" onClick={enter} disabled={loading}>{loading?'جاري التحقق...':'دخول إلى الكويز'} <ArrowRight size={18}/></button></section></main> }

function TakeQuiz({ quiz, studentName, onSubmit }) {
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState(null);
  const [answers, setAnswers] = useState([]);
  const [seconds, setSeconds] = useState(Number(quiz.duration || 30) * 60);
  const [startedAt] = useState(() => new Date().toISOString());
  const [failed, setFailed] = useState(null);
  const [failMsg, setFailMsg] = useState('');
  const done = useRef(false);
  const q = quiz.questions[index];

  // answers = array of chosen option indexes (null = unanswered); the server does the grading
  const finish = async finalAnswers => {
    if (done.current) return;
    done.current = true;
    setFailed(null);
    const res = await onSubmit({ quizId: quiz.id, studentName, answers: finalAnswers, startedAt });
    if (res !== true) { done.current = false; setFailMsg(typeof res === 'string' ? res : ''); setFailed(finalAnswers); }
  };

  useEffect(() => {
    const timer = setInterval(() => setSeconds(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, []);

  // time is up: submit whatever has been answered so far (including the current selection)
  useEffect(() => {
    if (seconds === 0) finish([...answers, selected]);
  }, [seconds]);

  const next = () => {
    if (selected === null) return;
    const nextAnswers = [...answers, selected];
    if (index === quiz.questions.length - 1) finish(nextAnswers);
    else { setAnswers(nextAnswers); setIndex(index + 1); setSelected(null); }
  };

  return <main className="take-page">
    <div className="take-top"><span>{quiz.title}</span><b>الوقت {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</b></div>
    <div className="progress"><span style={{ width: `${((index + 1) / quiz.questions.length) * 100}%` }}/></div>
    <section className="question-card">
      <p className="eyebrow">السؤال {index + 1} من {quiz.questions.length}</p>
      <h2>{q.question}</h2>
      <div className="answers">{q.answers.map((a, i) => <button key={i} className={selected === i ? 'answer selected' : 'answer'} onClick={() => setSelected(i)}><span className="letter">{LETTERS[i]}</span>{a}</button>)}</div>
      {failed && <div className="error-msg">{failMsg || 'تعذر إرسال إجاباتك. تأكد من الاتصال بالإنترنت.'} <button className="primary" onClick={() => finish(failed)}>إعادة الإرسال</button></div>}
      <button className="primary next" disabled={selected === null || done.current} onClick={next}>{index === quiz.questions.length - 1 ? 'إنهاء الامتحان' : 'السؤال التالي'} <ArrowRight size={17}/></button>
    </section>
  </main>;
}
function StudentResult({ score }) {
  return <main className="student-result">
    <div className="success-icon"><CheckCircle2 size={40}/></div>
    <h1>تم تسليم إجابتك</h1>
    {score && <p className="final-score">نتيجتك: <b>{score.score}</b> من <b>{score.total}</b></p>}
    <p>تم تسجيل نتيجتك بنجاح. يمكنك إغلاق الصفحة الآن.</p>
    <button className="primary" onClick={() => location.reload()}>العودة للبداية</button>
  </main>;
}
