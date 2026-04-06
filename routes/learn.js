import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import {
  createLearnDb,
  verifyPassword,
  getModuleProgress,
  markModuleComplete,
  saveQuizAttempt,
  getQuizAttempts,
  getBestQuizScore,
  getOverallProgress,
} from '../services/learn-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load course data
const sectionsPath = join(__dirname, '../data/learn/sections.json');
const quizzesPath = join(__dirname, '../data/learn/quizzes.json');

let sectionsData = [];
let quizzesData = [];

try {
  sectionsData = JSON.parse(readFileSync(sectionsPath, 'utf-8'));
  quizzesData = JSON.parse(readFileSync(quizzesPath, 'utf-8'));
  console.log(`Loaded ${sectionsData.length} sections and ${quizzesData.length} quizzes`);
} catch (err) {
  console.error('Failed to load learn data:', err.message);
}

// Initialize database
const db = createLearnDb();

// Session store (in-memory for simplicity)
const sessions = new Map();

function generateSessionId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function requireAuth(req, res, next) {
  const sessionId = req.headers.cookie?.match(/learn_session=([^;]+)/)?.[1];
  const session = sessionId ? sessions.get(sessionId) : null;

  if (!session || !session.studentId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  req.student = session;
  next();
}

// Quiz answer key with correct answers — matched to actual exported questions
const QUIZ_ANSWERS = {
  26: [ // Quiz del Giorno — Daily Challenge
    { slot: 1, correct: 'Nevertheless' },
    { slot: 2, correct: 'goes' },
    { slot: 3, correct: 'had already left' },
    { slot: 4, correct: "mustn't" },
    { slot: 5, correct: 'is going to' },
    { slot: 6, correct: 'had had' },
    { slot: 7, correct: 'will have been completed' },
    { slot: 8, correct: 'would call' },
    { slot: 9, correct: 'Hardly' },
    { slot: 10, correct: 'I was wondering whether it might be possible to reschedule the meeting.' },
  ],
  8: [ // Present Tenses (B1)
    { slot: 1, correct: 'is working' },
    { slot: 2, correct: 'works' },
    { slot: 3, correct: 'boils' },
    { slot: 4, correct: 'are playing' },
    { slot: 5, correct: 'have' },
    { slot: 6, correct: ['has been introducing', 'has introduced'] },
    { slot: 7, correct: ['was walking'] },
    { slot: 8, correct: ['had been operating'] },
    { slot: 9, correct: ["hasn't replied", 'has not replied'] },
    { slot: 10, correct: ['sets'] },
    { slot: 11, correct: ['have worked', 'have been working'] },
    { slot: 12, correct: ['had already started', 'had started'] },
    { slot: 13, correct: ['I have worked for this company for three years', 'I have been working for this company for three years'] },
    { slot: 14, correct: ['The train leaves at 6pm every day', 'The train leaves at 18:00 every day', 'The train departs at 6pm every day'] },
  ],
  19: [ // Past Tenses (B1)
    { slot: 1, correct: 'moved' },
    { slot: 2, correct: 'was cooking' },
    { slot: 3, correct: 'had already started' },
    { slot: 4, correct: 'had been walking' },
    { slot: 5, correct: 'were you doing' },
    { slot: 6, correct: 'However' },
    { slot: 7, correct: 'Consequently' },
    { slot: 8, correct: 'despite' },
    { slot: 9, correct: 'Nevertheless' },
    { slot: 10, correct: ['is going to rain'] },
    { slot: 11, correct: ['will send'] },
    { slot: 12, correct: ['will have grown'] },
    { slot: 13, correct: ['will be lying', 'will be relaxing'] },
    { slot: 14, correct: ['will have finished'] },
    { slot: 15, correct: ['is going to make', 'is about to make'] },
    { slot: 16, correct: ['drops', 'reaches'] },
    { slot: 17, correct: ['invests', 'invested'] },
    { slot: 18, correct: ['register'] },
    { slot: 19, correct: ['were', 'was'] },
    { slot: 20, correct: ['The proposal will be approved by the committee next month'] },
    { slot: 21, correct: ['The data is currently being analysed by researchers', 'The data are currently being analysed by researchers'] },
    { slot: 22, correct: ['New measures have been introduced by the government'] },
    { slot: 23, correct: ['This technology was developed in 2019'] },
  ],
  9: [ // Conditionals & Modals (B1→B2)
    { slot: 1, correct: 'had' },
    { slot: 2, correct: 'would have passed' },
    { slot: 3, correct: 'will' },
    { slot: 4, correct: 'must' },
    { slot: 5, correct: 'could' },
    { slot: 6, correct: 'My brother, who lives in London, is a doctor.' },
    { slot: 7, correct: ['had invested'] },
    { slot: 8, correct: ['had studied'] },
    { slot: 9, correct: ["hadn't made", 'had not made'] },
    { slot: 10, correct: ['had practised', 'had practiced'] },
    { slot: 11, correct: ['she would call him the following day', 'she would call him the next day'] },
    { slot: 12, correct: ['if he had finished the report', 'whether he had finished the report'] },
    { slot: 13, correct: ['should have planned', 'could have planned'] },
  ],
  20: [ // Relative Clauses & Reported Speech (B2)
    { slot: 1, correct: 'who' },
    { slot: 2, correct: 'who' },
    { slot: 3, correct: 'was' },
    { slot: 4, correct: 'lived' },
    { slot: 5, correct: 'that' },
  ],
  21: [ // Formal vs Informal (B2)
    { slot: 1, correct: 'obtain' },
    { slot: 2, correct: 'assist' },
    { slot: 3, correct: 'I would like to enquire about the vacancy.' },
    { slot: 4, correct: 'significant' },
    { slot: 5, correct: 'Yours sincerely' },
  ],
  22: [ // Idioms & Collocations (B2)
    { slot: 1, correct: 'make' },
    { slot: 2, correct: 'start a conversation in a social situation' },
    { slot: 3, correct: 'heavy' },
    { slot: 4, correct: 'very rarely' },
    { slot: 5, correct: 'responsibility' },
  ],
  10: [ // Advanced Grammar (B2→C1)
    { slot: 1, correct: 'have' },
    { slot: 2, correct: 'a cleft sentence' },
    { slot: 3, correct: 'is' },
    { slot: 4, correct: 'did' },
    { slot: 5, correct: 'Had' },
  ],
  23: [ // Hedging & Diplomacy (C1)
    { slot: 1, correct: 'It could be argued that there might be an alternative perspective.' },
    { slot: 2, correct: 'hedging language' },
    { slot: 3, correct: 'nonetheless' },
    { slot: 4, correct: 'I was wondering if you could possibly help me.' },
    { slot: 5, correct: 'introduce a topic formally' },
  ],
  24: [ // Reading Strategies (C1)
    { slot: 1, correct: 'Skimming' },
    { slot: 2, correct: 'Scanning' },
    { slot: 3, correct: 'inferring' },
    { slot: 4, correct: 'evaluating' },
    { slot: 5, correct: 'implicit meaning and cultural references' },
  ],
  11: [ // C1 Readiness Check
    { slot: 1, correct: '220-260 words' },
    { slot: 2, correct: 'Paraphrase the question using different words' },
    { slot: 3, correct: 'speak for about 1 minute about visual prompts' },
    { slot: 4, correct: 'not spending too long on one question' },
    { slot: 5, correct: 'It demonstrates higher language competence.' },
  ],
  25: [ // Course Review
    { slot: 1, correct: 'If I had more time, I would travel the world.' },
    { slot: 2, correct: 'however / despite that' },
    { slot: 3, correct: 'Never have I experienced such kindness.' },
    { slot: 4, correct: 'There appears to be some evidence suggesting...' },
    { slot: 5, correct: 'My mother, who is 65, still works full-time.' },
  ],
};

function normalizeAnswer(answer) {
  return String(answer || '')
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:'"]/g, '');
}

function expandContractions(text) {
  const contractions = {
    "hasn't": "has not", "haven't": "have not", "hadn't": "had not",
    "doesn't": "does not", "don't": "do not", "didn't": "did not",
    "isn't": "is not", "aren't": "are not", "wasn't": "was not", "weren't": "were not",
    "won't": "will not", "wouldn't": "would not", "couldn't": "could not",
    "shouldn't": "should not", "mustn't": "must not", "can't": "cannot",
    "it's": "it is", "he's": "he is", "she's": "she is",
    "i'm": "i am", "we're": "we are", "they're": "they are",
    "i've": "i have", "we've": "we have", "they've": "they have",
    "i'll": "i will", "we'll": "we will", "they'll": "they will",
    "i'd": "i would", "we'd": "we would", "they'd": "they would",
  };
  let lower = text.toLowerCase();
  for (const [contraction, expansion] of Object.entries(contractions)) {
    lower = lower.replace(new RegExp(contraction.replace("'", "[''`]"), 'g'), expansion);
  }
  return lower;
}

function checkAnswer(userAnswer, correctAnswer, type) {
  const normalized = normalizeAnswer(userAnswer);
  const expandedUser = expandContractions(String(userAnswer || '').trim());

  if (type === 'multichoice') {
    return normalizeAnswer(correctAnswer) === normalized;
  }

  // For shortanswer, accept multiple valid forms + contraction variants
  const candidates = Array.isArray(correctAnswer) ? correctAnswer : [correctAnswer];
  return candidates.some(ans => {
    if (normalizeAnswer(ans) === normalized) return true;
    // Also compare expanded contractions
    const expandedCorrect = expandContractions(String(ans || '').trim());
    if (normalizeAnswer(expandedCorrect) === normalizeAnswer(expandedUser)) return true;
    return false;
  });
}

const router = express.Router();

// Auth endpoints
router.post('/learn/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const student = verifyPassword(db, username.toLowerCase(), password);

  if (!student) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const sessionId = generateSessionId();
  sessions.set(sessionId, {
    studentId: student.id,
    username: student.username,
  });

  res.cookie('learn_session', sessionId, {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });

  res.json({ success: true, student: { username: student.username } });
});

router.post('/learn/logout', (req, res) => {
  const sessionId = req.headers.cookie?.match(/learn_session=([^;]+)/)?.[1];
  if (sessionId) {
    sessions.delete(sessionId);
  }
  res.clearCookie('learn_session');
  res.json({ success: true });
});

// Get course data
router.get('/learn/api/sections', requireAuth, (req, res) => {
  res.json(sectionsData);
});

router.get('/learn/api/section/:id', requireAuth, (req, res) => {
  const sectionId = parseInt(req.params.id);
  const section = sectionsData.find(s => s.id === sectionId);

  if (!section) {
    return res.status(404).json({ error: 'Section not found' });
  }

  res.json(section);
});

router.get('/learn/api/quizzes', requireAuth, (req, res) => {
  // Return quizzes without correct answers
  const quizzesWithoutAnswers = quizzesData.map(q => ({
    quiz_id: q.quiz_id,
    cmid: q.cmid,
    name: q.name,
    grade: q.grade,
    question_count: q.questions.length,
  }));

  res.json(quizzesWithoutAnswers);
});

router.get('/learn/api/quiz/:id', requireAuth, (req, res) => {
  const quizId = parseInt(req.params.id);
  const quiz = quizzesData.find(q => q.quiz_id === quizId);

  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }

  // Return quiz without correct answers
  res.json({
    quiz_id: quiz.quiz_id,
    cmid: quiz.cmid,
    name: quiz.name,
    grade: quiz.grade,
    questions: quiz.questions,
  });
});

// Submit quiz — uses correct_index/correct_answer from quizzes.json
router.post('/learn/api/quiz/:id/submit', requireAuth, (req, res) => {
  const quizId = parseInt(req.params.id);
  const { answers } = req.body;

  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'Invalid answers format' });
  }

  const quiz = quizzesData.find(q => q.quiz_id === quizId);
  if (!quiz) {
    return res.status(404).json({ error: 'Quiz not found' });
  }

  // Also check legacy QUIZ_ANSWERS as fallback
  const legacyAnswers = QUIZ_ANSWERS[quizId];

  let score = 0;
  const results = [];

  for (const question of quiz.questions) {
    const userAnswer = answers[question.slot];
    let isCorrect = false;
    let correctDisplay = '';

    if (question.type === 'multichoice') {
      // For multichoice: compare index directly
      if (question.correct_index !== undefined && question.correct_index !== null) {
        const userIdx = parseInt(userAnswer);
        isCorrect = userIdx === question.correct_index;
        correctDisplay = question.options?.[question.correct_index] || '';
      } else if (question.correct_answer) {
        // Fallback to text comparison
        isCorrect = normalizeAnswer(userAnswer) === normalizeAnswer(question.correct_answer);
        correctDisplay = question.correct_answer;
      } else {
        // Legacy fallback
        const legacy = legacyAnswers?.find(a => a.slot === question.slot);
        if (legacy) {
          // User sends index, find the option text, compare with legacy correct text
          const userIdx = parseInt(userAnswer);
          const userText = question.options?.[userIdx] || '';
          isCorrect = checkAnswer(userText, legacy.correct, 'multichoice');
          correctDisplay = Array.isArray(legacy.correct) ? legacy.correct[0] : legacy.correct;
        }
      }
    } else if (question.type === 'shortanswer') {
      // For shortanswer: text comparison
      const correctAns = question.correct_answer;
      if (correctAns) {
        isCorrect = checkAnswer(userAnswer, correctAns, 'shortanswer');
        correctDisplay = correctAns;
      } else {
        const legacy = legacyAnswers?.find(a => a.slot === question.slot);
        if (legacy) {
          isCorrect = checkAnswer(userAnswer, legacy.correct, 'shortanswer');
          correctDisplay = Array.isArray(legacy.correct) ? legacy.correct[0] : legacy.correct;
        }
      }
    }

    if (isCorrect) score++;

    results.push({
      slot: question.slot,
      correct: isCorrect,
      userAnswer,
      correctAnswer: correctDisplay,
    });
  }

  const maxScore = quiz.questions.length;
  const percentage = (score / maxScore) * 100;

  // Save attempt to database
  saveQuizAttempt(db, req.student.studentId, quizId, score, maxScore, answers);

  res.json({
    score,
    maxScore,
    percentage: Math.round(percentage * 10) / 10,
    results,
  });
});

// Progress endpoints
router.get('/learn/api/progress', requireAuth, (req, res) => {
  const moduleProgress = getModuleProgress(db, req.student.studentId);
  const overall = getOverallProgress(db, req.student.studentId);
  const recentAttempts = getQuizAttempts(db, req.student.studentId)
    .slice(0, 10)
    .map(attempt => {
      const quiz = quizzesData.find(q => q.quiz_id === attempt.quiz_id);
      return {
        ...attempt,
        quizName: quiz?.name || 'Unknown Quiz',
        percentage: Math.round((attempt.score / attempt.max_score) * 100),
      };
    });

  // Get best scores for each quiz
  const quizScores = quizzesData.map(quiz => {
    const best = getBestQuizScore(db, req.student.studentId, quiz.quiz_id);
    return {
      quiz_id: quiz.quiz_id,
      name: quiz.name,
      bestScore: best?.best_score || 0,
      maxScore: best?.max_score || quiz.questions.length,
      percentage: best?.best_score
        ? Math.round((best.best_score / best.max_score) * 100)
        : 0,
      attempted: !!best?.best_score,
    };
  });

  res.json({
    overall,
    moduleProgress,
    quizScores,
    recentAttempts,
  });
});

router.post('/learn/api/module/:id/complete', requireAuth, (req, res) => {
  const moduleId = parseInt(req.params.id);
  markModuleComplete(db, req.student.studentId, moduleId);
  res.json({ success: true });
});

export function createLearnRouter() {
  return router;
}
