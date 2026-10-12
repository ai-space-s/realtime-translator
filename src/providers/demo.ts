import { emptyTranscript, type Session, type SessionOptions } from '../types';
import { pairedCaptionFrames } from '../../shared/caption-flow.mjs';

const phrases: Record<string, string[]> = {
  ko: ['안녕하세요. 오늘 함께 이야기할 수 있어서 반갑습니다.', '우리는 서로 다른 언어를 사용하지만, 같은 생각을 나눌 수 있어요.', '다음 회의는 수요일 오후 두 시에 시작합니다.', '좋습니다. 그럼 그때 다시 만나요. 감사합니다!'],
  en: ['Hello. It is lovely to speak with you today.', 'We speak different languages, but we can share the same ideas.', 'The next meeting starts at two o’clock on Wednesday afternoon.', 'Sounds great. See you then. Thank you!'],
  ja: ['こんにちは。今日お話しできてうれしいです。', '違う言語を話していても、同じ思いを共有できます。', '次の会議は水曜日の午後2時に始まります。', 'いいですね。それでは、またその時に。ありがとうございます！'],
  zh: ['您好，很高兴今天能和您交流。', '虽然我们说着不同的语言，但我们可以分享相同的想法。', '下次会议将于星期三下午两点开始。', '好的，到时再见。谢谢！'],
  es: ['Hola. Me alegra poder hablar contigo hoy.', 'Hablamos distintos idiomas, pero podemos compartir las mismas ideas.', 'La próxima reunión empieza el miércoles a las dos de la tarde.', 'Perfecto. Nos vemos entonces. ¡Gracias!'],
  fr: ['Bonjour. Je suis ravi de pouvoir vous parler aujourd’hui.', 'Nous parlons des langues différentes, mais nous pouvons partager les mêmes idées.', 'La prochaine réunion commence mercredi à quatorze heures.', 'Très bien. À bientôt, et merci !'],
  de: ['Hallo. Es freut mich, heute mit Ihnen zu sprechen.', 'Wir sprechen verschiedene Sprachen, können aber dieselben Gedanken teilen.', 'Das nächste Treffen beginnt am Mittwoch um vierzehn Uhr.', 'Sehr gut. Bis dahin. Vielen Dank!'],
  vi: ['Xin chào. Rất vui được trò chuyện với bạn hôm nay.', 'Chúng ta nói những ngôn ngữ khác nhau nhưng có thể chia sẻ cùng ý tưởng.', 'Cuộc họp tiếp theo bắt đầu lúc hai giờ chiều thứ Tư.', 'Tuyệt vời. Hẹn gặp lại. Cảm ơn bạn!'],
  id: ['Halo. Senang bisa berbicara dengan Anda hari ini.', 'Kita berbicara dalam bahasa yang berbeda, tetapi kita dapat berbagi gagasan yang sama.', 'Pertemuan berikutnya dimulai pada hari Rabu pukul dua siang.', 'Baik. Sampai jumpa nanti. Terima kasih!'],
  lo: ['ສະບາຍດີ. ດີໃຈທີ່ໄດ້ລົມກັບທ່ານໃນມື້ນີ້.', 'ພວກເຮົາເວົ້າຕ່າງພາສາກັນ ແຕ່ສາມາດແບ່ງປັນຄວາມຄິດດຽວກັນໄດ້.', 'ການປະຊຸມຄັ້ງຕໍ່ໄປຈະເລີ່ມໃນວັນພຸດ ເວລາສອງໂມງແລງ.', 'ດີຫຼາຍ. ແລ້ວພົບກັນໃໝ່. ຂອບໃຈ!'],
};

// Do not split Lao vowel/tone marks from their base character in the demo.
function partialPhrase(text: string, progress: number, locale: string) {
  const characters = Array.from(new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(text), part => part.segment);
  return characters.slice(0, Math.ceil(characters.length * progress)).join('');
}

export async function startDemo(options: SessionOptions): Promise<Session> {
  const transcript = emptyTranscript();
  const pairs: { source: string; target: string }[] = [];
  let tick = 0;
  let muted = false;
  let closed = false;
  const stop = () => { closed = true; clearInterval(timer); options.signal.removeEventListener('abort', stop); options.onLevel(0); };
  const timer = setInterval(() => {
    if (muted || closed) return;
    tick++;
    const phrase = Math.floor((tick - 1) / 40);
    if (phrase >= 4) { stop(); options.onEnded(); return; }
    const progress = ((tick - 1) % 40 + 1) / 40;
    const source = phrases[options.source][phrase];
    const target = phrases[options.target][phrase];
    transcript.interimSource = progress < 0.8 ? partialPhrase(source, Math.min(1, progress * 1.3), options.source) : '';
    transcript.interimTarget = partialPhrase(target, Math.max(0, (progress - 0.18) / 0.82), options.target);
    options.onLevel(0.1 + Math.abs(Math.sin(tick * 0.6)) * 0.6);
    // Demonstrate recognition completion before translation arrival, not just
    // simultaneous final pairs: the source must leave the bottom at this point.
    if (progress === 0.8) {
      transcript.source += `${transcript.source ? '\n\n' : ''}${source}`;
      pairs.push({ source, target: '' });
    }
    if (progress === 1) {
      transcript.target += `${transcript.target ? '\n\n' : ''}${target}`;
      transcript.interimSource = ''; transcript.interimTarget = '';
      pairs.at(-1)!.target = target;
    }
    transcript.captions = pairedCaptionFrames(pairs, transcript.interimSource, options.source, options.target);
    options.onTranscript({ ...transcript });
  }, 110);
  options.signal.addEventListener('abort', stop, { once: true });
  return { stop: async () => stop(), setMuted: value => { muted = value; if (value) options.onLevel(0); } };
}
