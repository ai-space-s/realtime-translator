import { seminarLimits, sectionsFromPages } from '../shared/seminar-context.mjs';

export async function readManuscript(file: File) {
  const pdf = /\.pdf$/i.test(file.name);
  if (!pdf && !/\.(txt|md)$/i.test(file.name)) throw new Error('PDF, UTF-8 TXT 또는 Markdown 파일을 선택해 주세요.');
  if (file.size > (pdf ? seminarLimits.pdfBytes : 320000)) throw new Error(pdf ? 'PDF는 30MB 이하로 준비해 주세요.' : '텍스트 파일은 320KB 이하로 준비해 주세요.');
  const data = await file.arrayBuffer();
  if (!pdf) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/u, ''); }
    catch { throw new Error('UTF-8 인코딩으로 저장한 텍스트 파일을 선택해 주세요.'); }
    if (text.includes('\0')) throw new Error('텍스트 파일 형식을 확인해 주세요.');
    return { sections: sectionsFromPages([{ page: 0, text }]), warning: '' };
  }
  if (!new TextDecoder().decode(data.slice(0, 1024)).includes('%PDF-')) throw new Error('유효한 PDF 파일을 선택해 주세요.');
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data, useSystemFonts: true });
  const timeout = setTimeout(() => { void task.destroy().catch(() => {}); }, 45000);
  try {
    const document = await task.promise;
    if (document.numPages > seminarLimits.pages) throw new Error('PDF는 200쪽 이하로 나누어 주세요.');
    const pages: { page: number; text: string }[] = [];
    const empty: number[] = [];
    let characters = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
      characters += text.length;
      if (characters > seminarLimits.characters) throw new Error('원고는 총 80,000자까지 사용할 수 있습니다. PDF를 나누어 주세요.');
      if (!text.trim()) empty.push(number);
      pages.push({ page: number, text });
      page.cleanup();
    }
    return { sections: sectionsFromPages(pages), warning: empty.length ? `텍스트가 없는 쪽: ${empty.join(', ')}. 사진·스캔 내용은 자동으로 읽지 않습니다. 필요한 설명을 직접 추가하세요.` : 'PDF의 표·사진 설명·읽기 순서를 확인하고 필요하면 수정하세요.' };
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('암호가 해제된 PDF를 선택해 주세요.');
    throw error instanceof Error ? error : new Error('PDF를 읽지 못했습니다. 파일을 확인해 주세요.');
  } finally { clearTimeout(timeout); await task.destroy().catch(() => {}); }
}
