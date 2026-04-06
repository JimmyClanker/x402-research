import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '../data/learn/learn.db');

// Ensure data/learn directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

export function createLearnDb() {
  const db = new Database(DB_PATH);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS module_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      module_id INTEGER NOT NULL,
      completed BOOLEAN DEFAULT 0,
      completed_at TEXT,
      FOREIGN KEY (student_id) REFERENCES students(id),
      UNIQUE(student_id, module_id)
    );

    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      quiz_id INTEGER NOT NULL,
      score REAL NOT NULL,
      max_score REAL NOT NULL,
      answers TEXT NOT NULL,
      submitted_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE INDEX IF NOT EXISTS idx_module_progress_student
      ON module_progress(student_id);
    CREATE INDEX IF NOT EXISTS idx_quiz_attempts_student
      ON quiz_attempts(student_id);
    CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz
      ON quiz_attempts(quiz_id);
  `);

  // Create default student (Alessia) if not exists
  const checkStudent = db.prepare('SELECT id FROM students WHERE username = ?');
  const alessia = checkStudent.get('alessia');

  if (!alessia) {
    const insertStudent = db.prepare(
      'INSERT INTO students (username, password_hash) VALUES (?, ?)'
    );
    // Simple password hash (in production, use bcrypt)
    insertStudent.run('alessia', 'EnglishB1C1');
    console.log('Created default student: alessia');
  }

  return db;
}

export function getStudentByUsername(db, username) {
  const stmt = db.prepare('SELECT * FROM students WHERE username = ?');
  return stmt.get(username);
}

export function verifyPassword(db, username, password) {
  const student = getStudentByUsername(db, username);
  if (!student) return null;
  // Simple password check (in production, use bcrypt)
  if (student.password_hash === password) {
    return student;
  }
  return null;
}

export function getModuleProgress(db, studentId) {
  const stmt = db.prepare(`
    SELECT module_id, completed, completed_at
    FROM module_progress
    WHERE student_id = ?
  `);
  return stmt.all(studentId);
}

export function markModuleComplete(db, studentId, moduleId) {
  const stmt = db.prepare(`
    INSERT INTO module_progress (student_id, module_id, completed, completed_at)
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(student_id, module_id)
    DO UPDATE SET completed = 1, completed_at = datetime('now')
  `);
  return stmt.run(studentId, moduleId);
}

export function saveQuizAttempt(db, studentId, quizId, score, maxScore, answers) {
  const stmt = db.prepare(`
    INSERT INTO quiz_attempts (student_id, quiz_id, score, max_score, answers)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(studentId, quizId, score, maxScore, JSON.stringify(answers));
}

export function getQuizAttempts(db, studentId, quizId = null) {
  let stmt;
  if (quizId) {
    stmt = db.prepare(`
      SELECT * FROM quiz_attempts
      WHERE student_id = ? AND quiz_id = ?
      ORDER BY submitted_at DESC
    `);
    return stmt.all(studentId, quizId);
  } else {
    stmt = db.prepare(`
      SELECT * FROM quiz_attempts
      WHERE student_id = ?
      ORDER BY submitted_at DESC
    `);
    return stmt.all(studentId);
  }
}

export function getBestQuizScore(db, studentId, quizId) {
  const stmt = db.prepare(`
    SELECT MAX(score) as best_score, max_score
    FROM quiz_attempts
    WHERE student_id = ? AND quiz_id = ?
  `);
  return stmt.get(studentId, quizId);
}

export function getOverallProgress(db, studentId) {
  const moduleCount = db.prepare(
    'SELECT COUNT(*) as count FROM module_progress WHERE student_id = ? AND completed = 1'
  ).get(studentId);

  const quizCount = db.prepare(`
    SELECT COUNT(DISTINCT quiz_id) as count
    FROM quiz_attempts
    WHERE student_id = ?
  `).get(studentId);

  const avgScore = db.prepare(`
    SELECT AVG(score / max_score * 100) as avg
    FROM (
      SELECT quiz_id, MAX(score) as score, max_score
      FROM quiz_attempts
      WHERE student_id = ?
      GROUP BY quiz_id
    )
  `).get(studentId);

  return {
    completedModules: moduleCount?.count || 0,
    attemptedQuizzes: quizCount?.count || 0,
    averageScore: avgScore?.avg || 0,
  };
}
