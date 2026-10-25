import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { linesFromItems, parseQuestionsFromLines } from './quizParser';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Guards so a huge or hostile file cannot freeze the browser tab.
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PAGES = 60;
const MAX_QUESTIONS = 100;

export async function importQuestionsFromPdf(file) {
  if (file.size > MAX_BYTES) throw new Error('حجم الملف كبير. الحد الأقصى 5 ميجابايت.');
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  if (pdf.numPages > MAX_PAGES) throw new Error(`عدد الصفحات كبير. الحد الأقصى ${MAX_PAGES} صفحة.`);

  const lines = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    lines.push(...linesFromItems((await page.getTextContent()).items));
  }
  if (!lines.length) throw new Error('الملف لا يحتوي على نص قابل للقراءة.');
  const questions = parseQuestionsFromLines(lines);
  if (!questions.length) throw new Error('استخدم الصيغة: 1. السؤال ثم A) اختيار و B) اختيار.');
  return questions.slice(0, MAX_QUESTIONS);
}
