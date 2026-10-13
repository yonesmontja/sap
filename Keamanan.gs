/**
 * LAPISAN KEAMANAN SERVER - EduRapor
 * ------------------------------------------------------------------
 * 1. Login (verifyUser) menerbitkan TOKEN SESI yang disimpan di server
 *    (CacheService, berlaku 6 jam sejak aktivitas terakhir).
 * 2. Semua fungsi data di Code.gs bersifat privat (berakhiran "_"),
 *    sehingga TIDAK bisa dipanggil langsung dari browser.
 * 3. Satu-satunya pintu dari browser adalah api(token, namaFungsi, argumen).
 *    Pintu ini memeriksa: sesi valid -> peran diizinkan -> aturan
 *    kepemilikan data -> baru menjalankan fungsi -> menyaring hasil.
 * 4. Peran diambil dari sesi di server, bukan dari sessionStorage browser,
 *    sehingga mengubah "role" di browser tidak memberi hak apa pun.
 *
 * Di browser, navbar.html membungkus google.script.run secara otomatis,
 * jadi kode halaman tetap memanggil google.script.run.namaFungsi(...)
 * seperti biasa.
 */

const SESSION_TTL_SECONDS = 21600; // 6 jam (batas maksimum CacheService)
const SESSION_PREFIX = 'sess_';

const ROLE_ADMIN = 'admin', ROLE_KEPSEK = 'kepsek', ROLE_GURU = 'guru', ROLE_SISWA = 'siswa';
const ALL_ROLES = [ROLE_ADMIN, ROLE_KEPSEK, ROLE_GURU, ROLE_SISWA];
const STAFF = [ROLE_ADMIN, ROLE_KEPSEK, ROLE_GURU];
const PIMPINAN = [ROLE_ADMIN, ROLE_KEPSEK];
const ADMIN_ONLY = [ROLE_ADMIN];

// Tabel yang hanya boleh diubah Admin/Kepsek
const PIMPINAN_TABLES = ['PengaturanSekolah', 'MasterGuru', 'MasterPeriode'];
// Tabel transaksi milik guru: guru hanya boleh mengubah/menghapus baris yang ia buat
const OWNED_TABLES = { 'TransNilai': 'id_nilai', 'TransJurnal': 'id_jurnal', 'TransJadwal': 'id_jadwal' };

// ==============================================================================
// LOGIN & SESI
// ==============================================================================
function verifyUser(u, p, r) {
  const res = verifyUserCore_(u, p, r);
  if (!res || !res.success) return res;

  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const session = {
    role: normalizeRole_(res.role),
    name: res.name || '',
    username: res.username || '',
    id_guru: res.id_guru || '',
    id_siswa: res.id_siswa || '',
    id_kelas: res.id_kelas || '',
    is_wali_kelas: !!res.is_wali_kelas,
    kelas_binaan: res.kelas_binaan || [],
    mapel_diampu: res.mapel_diampu || []
  };
  CacheService.getScriptCache().put(SESSION_PREFIX + token, JSON.stringify(session), SESSION_TTL_SECONDS);

  saveLogAktivitasBatch_([{
    username: session.name || session.username, role: session.role,
    modul: 'Autentikasi', aktivitas: 'Login ke dalam sistem EduRapor.'
  }]);

  res.token = token;
  return res;
}

function normalizeRole_(role) {
  role = String(role || '').toLowerCase();
  if (role === ROLE_SISWA || role === ROLE_GURU || role === ROLE_KEPSEK) return role;
  return ROLE_ADMIN; // admin, operator, dan peran lain dari sheet Users (sama seperti filter menu)
}

function getSession_(token) {
  if (!token) throw new Error('SESI_TIDAK_VALID: Anda belum login.');
  const cache = CacheService.getScriptCache();
  const raw = cache.get(SESSION_PREFIX + token);
  if (!raw) throw new Error('SESI_TIDAK_VALID: Sesi login sudah berakhir.');
  cache.put(SESSION_PREFIX + token, raw, SESSION_TTL_SECONDS); // perpanjang selama masih aktif
  return JSON.parse(raw);
}

function logoutSession_(session, token) {
  saveLogAktivitasBatch_([{
    username: session.name || session.username, role: session.role,
    modul: 'Autentikasi', aktivitas: 'Logout (keluar) dari sistem EduRapor.'
  }]);
  CacheService.getScriptCache().remove(SESSION_PREFIX + token);
  return { success: true };
}

// ==============================================================================
// PINTU TUNGGAL DARI BROWSER
// ==============================================================================
function api(token, fnName, args) {
  const session = getSession_(token);
  args = Array.isArray(args) ? args : [];

  if (fnName === 'logoutSession') return logoutSession_(session, token);

  const rule = API_RULES[fnName];
  if (!rule) throw new Error('Fungsi tidak dikenal: ' + fnName);
  if (rule.roles.indexOf(session.role) === -1) {
    throw new Error('AKSES_DITOLAK: Peran Anda (' + session.role + ') tidak diizinkan menjalankan ' + fnName + '.');
  }
  if (rule.guard) rule.guard(session, args);

  const fn = rule.fn();
  if (typeof fn !== 'function') throw new Error('Fungsi server tidak ditemukan: ' + fnName);
  let result = fn.apply(null, args);
  if (rule.filter) result = rule.filter(session, result, args);
  return result;
}

function deny_(msg) {
  throw new Error('AKSES_DITOLAK: ' + msg);
}

// Daftar fungsi yang boleh dipanggil dari browser beserta peran yang diizinkan.
// fn ditulis sebagai fungsi agar dibaca saat dipanggil.
const API_RULES = {
  // --- Baca data ---
  getMasterReferences:           { roles: ALL_ROLES, fn: () => getMasterReferences_, guard: guardMasterReferences_, filter: filterByRole_ },
  getTransactionalDataByContext: { roles: ALL_ROLES, fn: () => getTransactionalDataByContext_, guard: guardTransContext_, filter: filterByRole_ },
  getDashboardMetrics:           { roles: ALL_ROLES, fn: () => getDashboardMetrics_ },
  getDashboardChartData:         { roles: ALL_ROLES, fn: () => getDashboardChartData_ },
  getRelationalData:             { roles: STAFF, fn: () => getRelationalData_, filter: filterByRole_ },
  getPaginatedMasterTable:       { roles: STAFF, fn: () => getPaginatedMasterTable_, guard: guardMasterTable_, filter: filterMasterTable_ },
  getExportMasterData:           { roles: STAFF, fn: () => getExportMasterData_, guard: guardMasterTable_, filter: filterMasterTable_ },
  getLaporanSTNKM:               { roles: STAFF, fn: () => getLaporanSTNKM_ },
  getPaginatedLogAktivitas:      { roles: PIMPINAN, fn: () => getPaginatedLogAktivitas_ },
  getExportLogAktivitas:         { roles: PIMPINAN, fn: () => getExportLogAktivitas_ },

  // --- Simpan / hapus data ---
  saveMasterData:          { roles: STAFF, fn: () => saveMasterData_, guard: guardSaveMaster_ },
  deleteMasterData:        { roles: STAFF, fn: () => deleteMasterData_, guard: guardDeleteMaster_ },
  deleteJurnalDanLampiran: { roles: STAFF, fn: () => deleteJurnalDanLampiran_, guard: guardDeleteJurnal_ },
  saveJurnalAnekdotal:     { roles: STAFF, fn: () => saveJurnalAnekdotal_, guard: guardJurnalRecord_ },
  updateJurnalAnekdotal:   { roles: STAFF, fn: () => updateJurnalAnekdotal_, guard: guardJurnalRecord_ },
  saveNilaiBatch:          { roles: STAFF, fn: () => saveNilaiBatch_ },
  saveBatchNilai:          { roles: STAFF, fn: () => globalThis['saveBatchNilai_'] || globalThis['saveBatchNilai'] },
  savePresensiBatch:       { roles: STAFF, fn: () => savePresensiBatch_ },
  saveJurnalBatch:         { roles: STAFF, fn: () => saveJurnalBatch_ },
  saveRekapBatch:          { roles: STAFF, fn: () => saveRekapBatch_ },
  saveCatatanP5Batch:      { roles: STAFF, fn: () => saveCatatanP5Batch_ },
  saveCatatanWaliFinal:    { roles: STAFF, fn: () => saveCatatanWaliFinal_ },
  saveBankPengetahuan:     { roles: STAFF, fn: () => saveBankPengetahuan_ },
  kalkulasiOtomatisP5:     { roles: STAFF, fn: () => kalkulasiOtomatisP5_ },
  uploadFileToDrive:       { roles: STAFF, fn: () => uploadFileToDrive_ },
  deleteJadwalBerantai:    { roles: STAFF, fn: () => deleteJadwalBerantai_, guard: guardDeleteJadwal_ },
  updateJadwalBerantai:    { roles: STAFF, fn: () => updateJadwalBerantai_, guard: guardUpdateJadwal_ },

  // --- AI ---
  analyzeJurnalWithGemini:   { roles: STAFF, fn: () => analyzeJurnalWithGemini_ },
  analyzeJurnalWithClaude:   { roles: STAFF, fn: () => analyzeJurnalWithClaude_ },
  analyzeJurnalWithQwen:     { roles: STAFF, fn: () => analyzeJurnalWithQwen_ },
  analyzeJurnalWithDeepSeek: { roles: STAFF, fn: () => analyzeJurnalWithDeepSeek_ },
  analyzeJurnalWithOpenkey:  { roles: STAFF, fn: () => analyzeJurnalWithOpenkey_ },
  generateCatatanAI:         { roles: STAFF, fn: () => generateCatatanAI_ },
  generateCatatanP5_AI:      { roles: STAFF, fn: () => generateCatatanP5_AI_ },

  // --- Pemeliharaan ---
  sinkronisasiUlangSTNKM:   { roles: PIMPINAN, fn: () => sinkronisasiUlangSTNKM_ },
  arsipkanDatabaseTahunan:  { roles: ADMIN_ONLY, fn: () => arsipkanDatabaseTahunan_ },

  // --- Log: nama & peran pelaku diambil dari sesi, bukan dari browser ---
  saveLogAktivitasBatch: { roles: ALL_ROLES, fn: () => saveLogAktivitasBatch_, guard: guardLog_ }
};

// ==============================================================================
// ATURAN KEPEMILIKAN & PENJAGA (GUARD)
// ==============================================================================
function isOwner_(session, idGuruValue) {
  const v = String(idGuruValue || '').trim().toLowerCase();
  if (!v) return false;
  return [session.id_guru, session.username, session.name].some(x => x && String(x).trim().toLowerCase() === v);
}

function findRows_(sheetName, predicate) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  return data
    .map(r => { let o = {}; headers.forEach((h, i) => o[h] = r[i]); return o; })
    .filter(predicate);
}

// Guru hanya boleh mengubah/menghapus baris yang ia buat sendiri.
function requireOwnRow_(session, sheetName, idField, idValue) {
  if (session.role !== ROLE_GURU || !idValue) return;
  const rows = findRows_(sheetName, r => String(r[idField]).trim() === String(idValue).trim());
  rows.forEach(r => {
    if (!isOwner_(session, r.id_guru)) deny_('Anda hanya dapat mengubah atau menghapus data yang Anda buat sendiri.');
  });
}

function guardTableAccess_(session, sheetName) {
  if (sheetName === 'Users' && session.role !== ROLE_ADMIN) deny_('Tabel Users hanya untuk Administrator.');
  if (PIMPINAN_TABLES.indexOf(sheetName) > -1 && PIMPINAN.indexOf(session.role) === -1) {
    deny_('Tabel ' + sheetName + ' hanya dapat diubah oleh Admin atau Kepala Sekolah.');
  }
}

function guardSaveMaster_(session, args) {
  const [sheetName, record, idField, oldId] = args;
  guardTableAccess_(session, sheetName);
  if (OWNED_TABLES[sheetName]) requireOwnRow_(session, sheetName, idField, oldId || (record && record[idField]));
}

function guardDeleteMaster_(session, args) {
  const [sheetName, idValue, idField] = args;
  guardTableAccess_(session, sheetName);
  if (OWNED_TABLES[sheetName]) requireOwnRow_(session, sheetName, idField, idValue);
}

function guardDeleteJurnal_(session, args) {
  const idJurnal = args[0];
  requireOwnRow_(session, 'TransJurnal', 'id_jurnal', idJurnal);
  // Hapus lampiran berdasarkan URL yang tercatat di database, bukan URL kiriman browser,
  // agar file Drive lain tidak bisa ikut terhapus.
  const row = findRows_('TransJurnal', r => String(r.id_jurnal).trim() === String(idJurnal).trim())[0];
  args[1] = row ? row.lampiran_url : '';
}

function guardJurnalRecord_(session, args) {
  const record = args[0] || {};
  requireOwnRow_(session, 'TransJurnal', 'id_jurnal', record.id_jurnal);
}

function guardDeleteJadwal_(session, args) {
  if (session.role !== ROLE_GURU) return;
  const [actionMode, idJadwal, idGroup] = args;
  const rows = actionMode === 'only_this'
    ? findRows_('TransJadwal', r => String(r.id_jadwal) === String(idJadwal))
    : findRows_('TransJadwal', r => String(r.id_group) === String(idGroup));
  rows.forEach(r => { if (!isOwner_(session, r.id_guru)) deny_('Anda hanya dapat menghapus jadwal milik Anda sendiri.'); });
}

function guardUpdateJadwal_(session, args) {
  if (session.role !== ROLE_GURU) return;
  const record = args[1] || {};
  const rows = findRows_('TransJadwal', r =>
    String(r.id_jadwal) === String(record.id_jadwal) || (record.id_group && String(r.id_group) === String(record.id_group)));
  rows.forEach(r => { if (!isOwner_(session, r.id_guru)) deny_('Anda hanya dapat mengubah jadwal milik Anda sendiri.'); });
}

function guardMasterReferences_(session, args) {
  if (session.role === ROLE_SISWA) args[0] = false; // siswa tidak menerima data keluarga
}

function guardTransContext_(session, args) {
  if (session.role === ROLE_SISWA) args[0] = session.id_kelas; // siswa hanya kelasnya sendiri
}

function guardMasterTable_(session, args) {
  if (args[0] === 'Users' && session.role !== ROLE_ADMIN) deny_('Tabel Users hanya untuk Administrator.');
}

function guardLog_(session, args) {
  const logs = Array.isArray(args[0]) ? args[0] : [];
  args[0] = logs.map(l => Object.assign({}, l, {
    username: session.name || session.username,
    role: session.role
  }));
}

// ==============================================================================
// PENYARINGAN HASIL BERDASARKAN PERAN
// NIP masih dipakai sebagai password login guru/kepsek, jadi tidak boleh
// terlihat oleh pihak yang tidak berwenang.
// ==============================================================================
const SISWA_TRANS_TABLES = ['TransNilai', 'TransPresensi', 'TransJurnal', 'TransCatatanWali', 'TransCatatanP5', 'TransNilaiP5'];

function filterByRole_(session, db) {
  if (!db || typeof db !== 'object') return db;
  const isPimpinan = PIMPINAN.indexOf(session.role) > -1;

  if (!isPimpinan && Array.isArray(db.MasterGuru)) {
    db.MasterGuru = db.MasterGuru.map(g => Object.assign({}, g, { nip_nik: '' }));
  }

  if (session.role === ROLE_SISWA) {
    const own = r => String(r.id_siswa) === String(session.id_siswa);
    if (Array.isArray(db.MasterSiswa)) db.MasterSiswa = db.MasterSiswa.filter(own);
    SISWA_TRANS_TABLES.forEach(t => { if (Array.isArray(db[t])) db[t] = db[t].filter(own); });
    db.MasterOrtu = [];
    db.MasterWali = [];
    if (Array.isArray(db.PengaturanSekolah)) {
      db.PengaturanSekolah = db.PengaturanSekolah.map(p => Object.assign({}, p, { nip_kepsek: '' }));
    }
  }
  return db;
}

function filterMasterTable_(session, result, args) {
  const tableName = args[0];
  if (tableName !== 'MasterGuru' || PIMPINAN.indexOf(session.role) > -1) return result;
  const strip = rows => rows.map(g => Object.assign({}, g, { nip_nik: '' }));
  if (Array.isArray(result)) return strip(result);
  if (result && Array.isArray(result.data)) result.data = strip(result.data);
  return result;
}
