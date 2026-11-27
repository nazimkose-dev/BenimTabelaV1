import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Modal, SafeAreaView, Alert, ActivityIndicator, TextInput, Share
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  getFirestore, collection, doc, setDoc, onSnapshot,
  query, orderBy, limit
} from 'firebase/firestore';

/* ============================================================
   FIREBASE AYARLARI (KENDİ PROJE BİLGİLERİNİ BURAYA YAPIŞTIR)
============================================================ */
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDrUiJr_A0_XVTpKvK8fuwa8S0GeZJbBro',
  authDomain: 'hasortaklar-e23a7.firebaseapp.com',
  projectId: 'hasortaklar-e23a7',
  storageBucket: 'hasortaklar-e23a7.firebasestorage.app',
  messagingSenderId: '1015572268673',
  appId: '1:1015572268673:web:1dc9361bfaafe5cdff2f80',
  measurementId: 'G-PCLJ134Z0Z',
};

const isFirebaseConfigured = Boolean(
  FIREBASE_CONFIG.apiKey &&
  FIREBASE_CONFIG.projectId &&
  FIREBASE_CONFIG.appId
);

let db = null;
let auth = null;

if (isFirebaseConfigured) {
  const app = getApps().length === 0
    ? initializeApp(FIREBASE_CONFIG)
    : getApps()[0];

  db = getFirestore(app);
  auth = getAuth(app);
}

/* ============================================================
   SABİTLER
============================================================ */
const STORAGE_KEY = '@has_ortaklar_v8';
const COLLECTION_NAME = 'generalSeries';

const SINGLE_PLAYERS = ['FATİH', 'SADIK', 'EMRE', 'NAZIM'];
const TEAM_NAMES = ['FATİH + SADIK', 'EMRE + NAZIM'];

const POINTS = [3, 2, 1, -1];
const TARGET = 15;

const emptyScores = () => [0, 0, 0, 0];
const emptySelection = () => [null, null, null, null];
const nowISO = () => new Date().toISOString();

function todayDateTR() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function defaultSeriesTitle(mode) {
  const label = mode === 'team' ? 'Eşli' : 'Tekli';
  return `${todayDateTR()} ${label} Genel Seri`;
}

function generateShareCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/* ============================================================
   SAF İŞ MANTIĞI
============================================================ */
function rankPlayers(scores) {
  return [0, 1, 2, 3].sort((a, b) => {
    if (scores[b] !== scores[a]) return scores[b] - scores[a];
    return a - b;
  });
}

function leadersOf(scores) {
  const top = Math.max(...scores);
  return scores.map((s, i) => (s === top ? i : -1)).filter(i => i !== -1);
}

function reachedTarget(scores) {
  return Math.max(...scores) >= TARGET;
}

function computeAwarded(ranking) {
  const awarded = emptyScores();
  ranking.forEach((player, place) => {
    if (player !== null && player !== undefined) {
      awarded[player] = POINTS[place];
    }
  });
  return awarded;
}

function placementTieGroups(scores, excludedPlayer) {
  const groups = {};
  scores.forEach((s, i) => {
    if (i === excludedPlayer) return;
    if (!groups[s]) groups[s] = [];
    groups[s].push(i);
  });
  return Object.keys(groups)
    .map(s => ({ score: Number(s), players: groups[s] }))
    .filter(g => g.players.length > 1)
    .sort((a, b) => b.score - a.score);
}

function buildFinalOrder(scores, winnerIdx, resolvedExtra = []) {
  if (winnerIdx === null || winnerIdx === undefined) {
    return rankPlayers(scores);
  }
  const rest = [0, 1, 2, 3].filter(i => i !== winnerIdx && !resolvedExtra.includes(i));
  const restSorted = rest.sort((a, b) => {
    if (scores[b] !== scores[a]) return scores[b] - scores[a];
    return a - b;
  });
  return [winnerIdx, ...resolvedExtra, ...restSorted];
}

function normalizePlacementGroup(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return { playerIdxs: [...raw], resolved: [] };
  }
  if (Array.isArray(raw.playerIdxs)) {
    return {
      playerIdxs: [...raw.playerIdxs],
      resolved: Array.isArray(raw.resolved) ? [...raw.resolved] : [],
    };
  }
  return null;
}

/* ============================================================
   SİMÜLASYON: Bir seriyi baştan sona yeniden hesaplar.
============================================================ */
function simulateSeries(rounds) {
  let daily = emptyScores();
  let tieBreak = false;
  let placementTieBreak = false;
  let placementGroup = null;
  let finished = false;
  let winner = null;
  const outRounds = [];

  for (let idx = 0; idx < rounds.length; idx++) {
    const r = rounds[idx];

    r.results.forEach(res => {
      daily[res.player] += res.points;
    });

    const roundPlacementGroup = normalizePlacementGroup(r.placementGroup);

    const roundOut = {
      ...r,
      no: idx + 1,
      scoresAfter: [...daily],
      placementGroup: roundPlacementGroup ? [...roundPlacementGroup.playerIdxs] : null,
    };
    outRounds.push(roundOut);

    if (r.isPlacementTieBreak && roundPlacementGroup) {
      const groupIdxs = roundPlacementGroup.playerIdxs;
      const baseResolved = roundPlacementGroup.resolved || [];
      const activePool = groupIdxs.filter(i => !baseResolved.includes(i));
      const candidates = activePool.length > 0 ? activePool : groupIdxs;

      const maxInGroup = Math.max(...candidates.map(i => daily[i]));
      const topInGroup = candidates.filter(i => daily[i] === maxInGroup);

      if (topInGroup.length === 1) {
        const updatedResolved = [...baseResolved, topInGroup[0]];
        const remaining = groupIdxs.filter(i => !updatedResolved.includes(i));

        if (remaining.length <= 1) {
          const finalResolved = remaining.length === 1
            ? [...updatedResolved, remaining[0]]
            : updatedResolved;

          const nextGroups = placementTieGroups(daily, winner)
            .filter(g => g.players.some(p => !finalResolved.includes(p)));

          if (nextGroups.length === 0) {
            placementTieBreak = false;
            placementGroup = null;
            finished = winner !== null && winner !== undefined;
          } else {
            placementTieBreak = true;
            placementGroup = { playerIdxs: nextGroups[0].players, resolved: [] };
          }
        } else {
          placementTieBreak = true;
          placementGroup = { playerIdxs: remaining, resolved: updatedResolved };
        }
      } else {
        placementTieBreak = true;
        placementGroup = { playerIdxs: groupIdxs, resolved: baseResolved };
      }
      continue;
    }

    if (r.isTieBreak) {
      const leaders = leadersOf(daily);
      if (leaders.length === 1) {
        tieBreak = false;
        winner = leaders[0];
        const groups = placementTieGroups(daily, winner);
        if (groups.length > 0) {
          placementTieBreak = true;
          placementGroup = { playerIdxs: groups[0].players, resolved: [] };
          finished = false;
        } else {
          placementTieBreak = false;
          placementGroup = null;
          finished = true;
        }
      } else {
        tieBreak = true;
      }
      continue;
    }

    if (reachedTarget(daily)) {
      const leaders = leadersOf(daily);
      if (leaders.length > 1) {
        tieBreak = true;
      } else {
        winner = leaders[0];
        const groups = placementTieGroups(daily, winner);
        if (groups.length > 0) {
          placementTieBreak = true;
          placementGroup = { playerIdxs: groups[0].players, resolved: [] };
          finished = false;
        } else {
          placementTieBreak = false;
          placementGroup = null;
          finished = true;
        }
      }
    }
  }

  const finalOrder = finished ? buildFinalOrder(daily, winner) : rankPlayers(daily);
  const awarded = finished ? computeAwarded(finalOrder) : emptyScores();

  return {
    daily,
    rounds: outRounds,
    finished,
    winner,
    tieBreak,
    placementTieBreak,
    placementGroup,
    ranking: finalOrder,
    awarded,
  };
}

/* ============================================================
   TARİH FORMAT
============================================================ */
function formatDate(value) {
  if (!value) return '-';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleString('tr-TR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return '-';
  }
}

/* ============================================================
   BAŞLANGIÇ DURUMU (MOD BAZLI)
============================================================ */
const makeModeState = (mode, customTitle = '') => {
  const ts = nowISO();
  const resolvedMode = mode === 'team' ? 'team' : 'single';
  const startDate = todayDateTR();
  return {
    cloudDocId: `gen-${resolvedMode}-${Date.now()}`,
    shareCode: generateShareCode(),
    startDateTR: startDate,
    seriesTitle: customTitle.trim() || defaultSeriesTitle(resolvedMode),
    mode: resolvedMode,
    overall: emptyScores(),
    daily: emptyScores(),
    selection: emptySelection(),
    rounds: [],
    completedSeries: [],
    archivedGeneralSeries: [],
    generalSeriesNo: 1,
    generalStartedAt: ts,
    seriesNo: 1,
    seriesStartedAt: ts,
    overallUpdatedAt: ts,
    finished: false,
    tieBreak: false,
    placementTieBreak: false,
    placementGroup: null,
    winner: null,
  };
};

function sanitizeModeState(raw, fallbackMode) {
  const base = makeModeState(fallbackMode);
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    cloudDocId: raw.cloudDocId || base.cloudDocId,
    shareCode: raw.shareCode || base.shareCode,
    startDateTR: raw.startDateTR || base.startDateTR,
    seriesTitle: raw.seriesTitle || defaultSeriesTitle(fallbackMode),
    mode: fallbackMode,
    overall: Array.isArray(raw.overall) && raw.overall.length === 4 ? [...raw.overall] : emptyScores(),
    daily: Array.isArray(raw.daily) && raw.daily.length === 4 ? [...raw.daily] : emptyScores(),
    selection: Array.isArray(raw.selection) && raw.selection.length === 4 ? [...raw.selection] : emptySelection(),
    rounds: Array.isArray(raw.rounds) ? raw.rounds : [],
    completedSeries: Array.isArray(raw.completedSeries) ? raw.completedSeries : [],
    archivedGeneralSeries: Array.isArray(raw.archivedGeneralSeries) ? raw.archivedGeneralSeries : [],
    placementGroup: normalizePlacementGroup(raw.placementGroup),
  };
}

const makeInitialStore = () => ({
  byMode: {
    single: makeModeState('single'),
    team: makeModeState('team'),
  },
});

/* ============================================================
   ANA UYGULAMA
============================================================ */
export default function App() {
  // Ekranlar: 'choice' | 'start_mode' | 'start_title' | 'watch_list' | 'board'
  const [screen, setScreen] = useState('choice');
  // Rol: 'owner' (seri başlatan) | 'viewer' (başkasının serisini takip eden)
  const [role, setRole] = useState('owner');
  const [mode, setMode] = useState('team');

  // Seri başlatma adımları
  const [setupMode, setSetupMode] = useState('team');
  const [setupTitle, setSetupTitle] = useState(() => defaultSeriesTitle('team'));

  // Yerel veri deposu
  const [store, setStore] = useState(() => makeInitialStore());

  // Bulut izleyici verileri
  const [cloudSeriesList, setCloudSeriesList] = useState([]);
  const [searchFilter, setSearchFilter] = useState('');
  const [watchedDocId, setWatchedDocId] = useState(null);
  const [watchedState, setWatchedState] = useState(null);
  const [syncStatus, setSyncStatus] = useState('idle'); // 'idle' | 'syncing' | 'ok' | 'error'

  // Modallar
  const [modal, setModal] = useState(-1);
  const [selectedHistory, setSelectedHistory] = useState(null);
  const [selectedGeneralArchive, setSelectedGeneralArchive] = useState(null);
  const [editRound, setEditRound] = useState(null);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [ready, setReady] = useState(false);
  const [authReady, setAuthReady] = useState(false);

/* ---------- FIREBASE ANONİM GİRİŞ ---------- */
useEffect(() => {
  let mounted = true;

  async function login() {
    try {
      if (!auth) {
        throw new Error('Firebase bağlantısı kurulamadı.');
      }

      if (!auth.currentUser) {
        await signInAnonymously(auth);
      }

      if (mounted) {
        setAuthReady(true);
        console.log('Firebase giriş başarılı:', auth.currentUser?.uid);
      }
    } catch (error) {
      console.log('Firebase giriş hatası:', error);
      if (mounted) {
        Alert.alert(
          'Firebase bağlantı hatası',
          error.message
        );
      }
    }
  }

  login();

  return () => {
    mounted = false;
  };
}, []);


  /* ---------- YEREL YÜKLEME ---------- */
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (!mounted) return;
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed && parsed.byMode) {
            setStore({
              byMode: {
                single: sanitizeModeState(parsed.byMode.single, 'single'),
                team: sanitizeModeState(parsed.byMode.team, 'team'),
              },
            });
          }
        }
      } catch {
        Alert.alert('Kayıt okunamadı', 'Yerel veriler yüklenirken sorun oluştu.');
      } finally {
        if (mounted) setReady(true);
      }
    })();
    return () => { mounted = false; };
  }, []);

  /* ---------- YEREL KAYDETME ---------- */
  useEffect(() => {
    if (!ready) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(store)).catch(() => {});
  }, [store, ready]);

  /* ---------- BULUTA YAYINLAMA (SERİ BAŞLATAN CİHAZ) ---------- */
  const activeOwnerState = store.byMode[mode === 'team' ? 'team' : 'single'];

  useEffect(() => {
    if (!ready || !authReady || !auth?.currentUser || !db || role !== 'owner' || screen !== 'board') return;
    const docId = activeOwnerState.cloudDocId;
    if (!docId) return;
    

    let cancelled = false;
    setSyncStatus('syncing');

    const payload = {
      id: docId,
      ownerUid: auth.currentUser?.uid,
      shareCode: activeOwnerState.shareCode || generateShareCode(),
      startDateTR: activeOwnerState.startDateTR || todayDateTR(),
      title: activeOwnerState.seriesTitle || defaultSeriesTitle(activeOwnerState.mode),
      mode: activeOwnerState.mode,
      updatedAt: activeOwnerState.overallUpdatedAt || nowISO(),
      createdAt: activeOwnerState.generalStartedAt || nowISO(),
      state: activeOwnerState,
    };

    setDoc(doc(db, COLLECTION_NAME, docId), payload, { merge: true })
      .then(() => {
        if (!cancelled) setSyncStatus('ok');
      })
      .catch(() => {
        if (!cancelled) setSyncStatus('error');
      });

    return () => { cancelled = true; };
  }, [activeOwnerState, ready, authReady, role, screen]);

  /* ---------- İZLEYİCİ: PAYLAŞILAN GENEL SERİLERİ LİSTELE ---------- */
  useEffect(() => {
    if (!db || screen !== 'watch_list') return;
    setSyncStatus('syncing');
    const q = query(
      collection(db, COLLECTION_NAME),
      orderBy('updatedAt', 'desc'),
      limit(40)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setCloudSeriesList(list);
        setSyncStatus('ok');
      },
      () => {
        setSyncStatus('error');
      }
    );
    return () => unsub();
  }, [screen]);

  /* ---------- İZLEYİCİ: SEÇİLEN GENEL SERİYİ CANLI TAKİP ET ---------- */
  useEffect(() => {
    if (!db || role !== 'viewer' || !watchedDocId || screen !== 'board') return;
    setSyncStatus('syncing');
    const unsub = onSnapshot(
      doc(db, COLLECTION_NAME, watchedDocId),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const incomingMode = data.mode === 'team' ? 'team' : 'single';
          setMode(incomingMode);
          setWatchedState(sanitizeModeState(data.state, incomingMode));
          setSyncStatus('ok');
        } else {
          setSyncStatus('error');
        }
      },
      () => {
        setSyncStatus('error');
      }
    );
    return () => unsub();
  }, [role, watchedDocId, screen]);

  /* ---------- AKTİF EKRAN VERİSİ ---------- */
  const isViewer = role === 'viewer';
  const activeMode = mode === 'team' ? 'team' : 'single';
  const state = isViewer
    ? (watchedState || makeModeState(activeMode))
    : store.byMode[activeMode];

  function updateModeState(targetMode, updater) {
    if (isViewer) return;
    setStore(prev => {
      const current = prev.byMode[targetMode] || makeModeState(targetMode);
      const nextModeState = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
      return {
        ...prev,
        byMode: {
          ...prev.byMode,
          [targetMode]: nextModeState,
        },
      };
    });
  }

  /* ---------- SERİ BAŞLATMA AKIŞI ---------- */
  function chooseStartMode(selectedMode) {
    const existing = store.byMode[selectedMode];
    const hasProgress =
      existing &&
      (existing.overall.some(v => v !== 0) ||
        existing.completedSeries.length > 0 ||
        existing.rounds.length > 0);

    setSetupMode(selectedMode);
    setSetupTitle(
      hasProgress && existing.seriesTitle
        ? existing.seriesTitle
        : defaultSeriesTitle(selectedMode)
    );
    setScreen('start_title');
  }

  function launchGeneralSeries(forceBrandNew = false) {
    const todayStr = todayDateTR();
    let finalTitle = setupTitle.trim();
    if (!finalTitle) {
      finalTitle = defaultSeriesTitle(setupMode);
    } else if (!/^\d{2}\.\d{2}\.\d{4}/.test(finalTitle)) {
      // Kullanıcı tarihi sildiyse başına gün.ay.yıl tarihini otomatik ekle
      finalTitle = `${todayStr} ${finalTitle}`;
    }

    if (forceBrandNew) {
      const fresh = makeModeState(setupMode, finalTitle);
      updateModeState(setupMode, fresh);
    } else {
      updateModeState(setupMode, prev => ({
        ...prev,
        cloudDocId: prev.cloudDocId || `gen-${setupMode}-${Date.now()}`,
        shareCode: prev.shareCode || generateShareCode(),
        startDateTR: prev.startDateTR || todayStr,
        seriesTitle: finalTitle,
        overallUpdatedAt: nowISO(),
      }));
    }

    setRole('owner');
    setMode(setupMode);
    setSelectedHistory(null);
    setSelectedGeneralArchive(null);
    setEditRound(null);
    setModal(-1);
    setScreen('board');
  }

  /* ---------- PAYLAŞIM MENÜSÜ ---------- */
  async function shareCurrentSeries() {
    const modeText = isTeam ? 'Eşli' : 'Tekli';
    const message =
      `HAS ORTAKLAR - Canlı Seri Takibi\n` +
      `Seri Adı: ${state.seriesTitle}\n` +
      `Başlangıç Tarihi: ${state.startDateTR || formatDate(state.generalStartedAt)}\n` +
      `Mod: ${modeText}\n` +
      `Seri Kodu: ${state.shareCode}\n\n` +
      `Uygulamayı açıp "Başkasının serisini takip et" seçeneğinden bu seriyi canlı izleyebilirsin.`;

    try {
      await Share.share({
        title: state.seriesTitle,
        message,
      });
    } catch {
      Alert.alert('Paylaşım açılamadı', 'Seri bilgilerini manuel olarak paylaşabilirsin.');
    }
  }

  /* ---------- İZLEYİCİ: LİSTEDEN SERİ SEÇ ---------- */
  function startWatchingSeries(item) {
    const incomingMode = item.mode === 'team' ? 'team' : 'single';
    setRole('viewer');
    setMode(incomingMode);
    setWatchedDocId(item.id);
    setWatchedState(sanitizeModeState(item.state, incomingMode));
    setSelectedHistory(null);
    setSelectedGeneralArchive(null);
    setEditRound(null);
    setModal(-1);
    setScreen('board');
  }

  /* ---------- ETİKETLER ---------- */
  const labels = activeMode === 'team' ? TEAM_NAMES : SINGLE_PLAYERS;
  const isTeam = activeMode === 'team';

  /* ---------- TÜRETİLMİŞ ---------- */
  const used = state.selection.filter(x => x !== null);
  const ranking = useMemo(() => rankPlayers(state.overall), [state.overall]);

  /* ---------- OYUNCU/TAKIM SEÇİMİ ---------- */
  function choosePlayer(playerIndex) {
    if (isViewer) return;
    updateModeState(activeMode, prev => {
      const next = [...prev.selection];
      for (let i = 0; i < next.length; i++) {
        if (i !== modal && next[i] === playerIndex) next[i] = null;
      }
      next[modal] = playerIndex;
      return { ...prev, selection: next };
    });
    setModal(-1);
  }

  /* ---------- YENİ GÜNLÜK SERİ ---------- */
  function newSeries() {
    if (isViewer) return;
    updateModeState(activeMode, prev => ({
      ...prev,
      daily: emptyScores(),
      selection: emptySelection(),
      rounds: [],
      seriesNo: prev.seriesNo + 1,
      seriesStartedAt: nowISO(),
      overallUpdatedAt: nowISO(),
      finished: false,
      tieBreak: false,
      placementTieBreak: false,
      placementGroup: null,
      winner: null,
    }));
    setSelectedHistory(null);
  }

  /* ---------- GENEL SERİ ADINI DEĞİŞTİR ---------- */
  function saveSeriesTitle() {
    if (isViewer) return;
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      Alert.alert('Hata', 'Seri adı boş olamaz.');
      return;
    }
    updateModeState(activeMode, prev => ({
      ...prev,
      seriesTitle: trimmed,
      overallUpdatedAt: nowISO(),
    }));
    setRenameModalOpen(false);
  }

  /* ---------- GENEL SERİYİ BİTİR VE ARŞİVLE ---------- */
  function archiveAndStartNewGeneralSeries() {
    if (isViewer) return;
    const hasAnyGeneralProgress =
      state.overall.some(v => v !== 0) ||
      state.completedSeries.length > 0 ||
      state.rounds.length > 0;

    if (!hasAnyGeneralProgress) {
      Alert.alert('Arşivlenecek veri yok', 'Genel seride henüz puan veya tamamlanmış seri bulunmuyor.');
      return;
    }

    Alert.alert(
      'Genel seriyi arşivle',
      `"${state.seriesTitle}" arşivlenecek ve bugünün tarihiyle (${todayDateTR()}) yeni genel seri başlatılacak. Hiçbir kayıt silinmez.`,
      [
        { text: 'Vazgeç', style: 'cancel' },
        {
          text: 'Arşivle ve Yeni Başlat',
          onPress: () => {
            updateModeState(activeMode, prev => {
              const endedAt = nowISO();
              const todayStr = todayDateTR();
              const generalRanking = rankPlayers(prev.overall);
              const generalWinner = generalRanking[0];
              const nextNo = prev.generalSeriesNo + 1;
              const archiveEntry = {
                id: `gen-${prev.generalSeriesNo}-${Date.now()}`,
                no: prev.generalSeriesNo,
                title: prev.seriesTitle,
                mode: prev.mode,
                startedAt: prev.generalStartedAt,
                archivedAt: endedAt,
                overall: [...prev.overall],
                ranking: generalRanking,
                winner: generalWinner,
                completedSeries: [...prev.completedSeries],
                unfinishedDaily: prev.rounds.length > 0
                  ? {
                      seriesNo: prev.seriesNo,
                      startedAt: prev.seriesStartedAt,
                      daily: [...prev.daily],
                      rounds: [...prev.rounds],
                      finished: prev.finished,
                      winner: prev.winner,
                    }
                  : null,
              };

              return {
                ...prev,
                cloudDocId: `gen-${prev.mode}-${Date.now()}`,
                shareCode: generateShareCode(),
                startDateTR: todayStr,
                seriesTitle: `${defaultSeriesTitle(prev.mode)} #${nextNo}`,
                overall: emptyScores(),
                daily: emptyScores(),
                selection: emptySelection(),
                rounds: [],
                completedSeries: [],
                archivedGeneralSeries: [archiveEntry, ...(prev.archivedGeneralSeries || [])],
                generalSeriesNo: nextNo,
                generalStartedAt: endedAt,
                seriesNo: 1,
                seriesStartedAt: endedAt,
                overallUpdatedAt: endedAt,
                finished: false,
                tieBreak: false,
                placementTieBreak: false,
                placementGroup: null,
                winner: null,
              };
            });
            setSelectedHistory(null);
            Alert.alert('Genel Seri Arşivlendi', 'Önceki genel seri ve günlük serileri arşiv kayıtlarına eklendi.');
          }
        }
      ]
    );
  }

  /* ---------- TÜMÜNÜ SIFIRLA (SADECE AKTİF MOD) ---------- */
  function resetActiveMode() {
    if (isViewer) return;
    const modeLabel = isTeam ? 'Eşli Mod' : 'Tekli Mod';
    Alert.alert(
      `${modeLabel} kayıtları silinsin mi?`,
      `Sadece ${modeLabel} verileri sıfırlanacak; diğer modun verileri etkilenmez.`,
      [
        { text: 'Vazgeç', style: 'cancel' },
        {
          text: 'Sıfırla',
          style: 'destructive',
          onPress: () => {
            Alert.alert('Emin misiniz?', `${modeLabel} tüm kayıtları kalıcı olarak silinecek.`, [
              { text: 'Hayır', style: 'cancel' },
              {
                text: 'Evet, sil',
                style: 'destructive',
                onPress: () => {
                  updateModeState(activeMode, makeModeState(activeMode));
                  setSelectedHistory(null);
                  setSelectedGeneralArchive(null);
                  setEditRound(null);
                }
              }
            ]);
          }
        }
      ]
    );
  }

  /* ============================================================
     SERİYİ BİTİR (mevcut günlük seri)
  ============================================================ */
  function finalizeSeriesState(prev, finalScores, rounds, finalOrder) {
    const awarded = computeAwarded(finalOrder);
    const updatedOverall = prev.overall.map((v, i) => v + awarded[i]);
    const winnerIndex = finalOrder[0];
    const completedAt = nowISO();

    const record = {
      id: `${prev.generalSeriesNo}-${prev.seriesNo}-${Date.now()}`,
      no: prev.seriesNo,
      generalSeriesNo: prev.generalSeriesNo,
      mode: prev.mode,
      startedAt: prev.seriesStartedAt,
      completedAt,
      rounds,
      finalDaily: [...finalScores],
      ranking: finalOrder,
      awarded,
      winner: winnerIndex,
    };

    return {
      nextState: {
        ...prev,
        overall: updatedOverall,
        overallUpdatedAt: completedAt,
        daily: finalScores,
        rounds,
        completedSeries: [record, ...prev.completedSeries],
        finished: true,
        tieBreak: false,
        placementTieBreak: false,
        placementGroup: null,
        winner: winnerIndex,
        selection: emptySelection(),
      },
      winnerIndex,
    };
  }

  function finishSeriesWithOrder(finalScores, rounds, finalOrder) {
    let decidedWinner = finalOrder[0];
    updateModeState(activeMode, prev => {
      const res = finalizeSeriesState(prev, finalScores, rounds, finalOrder);
      decidedWinner = res.winnerIndex;
      return res.nextState;
    });
    Alert.alert('GÜNLÜK SERİ TAMAMLANDI!', `${labels[decidedWinner]} kazandı.`);
  }

  function finishSeries(finalScores, rounds, winnerIndex) {
    const order = buildFinalOrder(finalScores, winnerIndex);
    finishSeriesWithOrder(finalScores, rounds, order);
  }

  /* ============================================================
     BİRİNCİLİK ÇÖZÜLDÜ → 2./3.lük beraberliği var mı?
  ============================================================ */
  function afterFirstPlaceResolved(finalScores, rounds, winnerIndex) {
    const groups = placementTieGroups(finalScores, winnerIndex);
    if (groups.length === 0) {
      finishSeries(finalScores, rounds, winnerIndex);
      return;
    }
    const g = groups[0];
    updateModeState(activeMode, prev => ({
      ...prev,
      daily: finalScores,
      rounds,
      winner: winnerIndex,
      overallUpdatedAt: nowISO(),
      finished: false,
      tieBreak: false,
      placementTieBreak: true,
      placementGroup: { playerIdxs: g.players, resolved: [] },
      selection: emptySelection(),
    }));
    Alert.alert(
      'SIRALAMA EŞİTLİĞİ',
      `${g.players.map(p => labels[p]).join(' - ')} aynı puanda. Aralarında bir el oynanacak.`
    );
  }

  /* ============================================================
     EL KAYDET (yeni el)
  ============================================================ */
  function saveRound() {
    if (isViewer) return;
    if (state.selection.some(x => x === null)) {
      Alert.alert('Eksik seçim', 'Dört sıranın da seçilmesi gerek.');
      return;
    }
    if (new Set(state.selection).size !== 4) {
      Alert.alert('Hata', 'Aynı oyuncu birden fazla sırada olamaz.');
      return;
    }

    const updatedDaily = [...state.daily];
    state.selection.forEach((player, place) => {
      updatedDaily[player] += POINTS[place];
    });

    const activeGroup = normalizePlacementGroup(state.placementGroup);

    const round = {
      no: state.rounds.length + 1,
      playedAt: nowISO(),
      results: state.selection.map((player, place) => ({
        player,
        place: place + 1,
        points: POINTS[place],
      })),
      scoresAfter: [...updatedDaily],
      isTieBreak: state.tieBreak,
      isPlacementTieBreak: state.placementTieBreak,
      placementGroup: state.placementTieBreak && activeGroup
        ? [...activeGroup.playerIdxs]
        : null,
    };
    const updatedRounds = [...state.rounds, round];

    /* ---- SIRALAMA EŞİTLİK BOZMA ---- */
    if (state.placementTieBreak && activeGroup) {
      const baseResolved = activeGroup.resolved || [];
      const activePool = activeGroup.playerIdxs.filter(i => !baseResolved.includes(i));
      const candidates = activePool.length > 0 ? activePool : activeGroup.playerIdxs;

      const maxInGroup = Math.max(...candidates.map(i => updatedDaily[i]));
      const topInGroup = candidates.filter(i => updatedDaily[i] === maxInGroup);

      if (topInGroup.length === 1) {
        const resolved = [...baseResolved, topInGroup[0]];
        const remaining = activeGroup.playerIdxs.filter(i => !resolved.includes(i));

        if (remaining.length <= 1) {
          const finalResolved = remaining.length === 1 ? [...resolved, remaining[0]] : resolved;
          const winnerIdx = state.winner;
          const finalOrder = buildFinalOrder(updatedDaily, winnerIdx, finalResolved);

          const nextGroups = placementTieGroups(updatedDaily, winnerIdx)
            .filter(g => g.players.some(p => !finalResolved.includes(p)));

          if (nextGroups.length === 0) {
            finishSeriesWithOrder(updatedDaily, updatedRounds, finalOrder);
            return;
          }

          const ng = nextGroups[0];
          updateModeState(activeMode, prev => ({
            ...prev,
            daily: updatedDaily,
            rounds: updatedRounds,
            overallUpdatedAt: nowISO(),
            selection: emptySelection(),
            placementGroup: { playerIdxs: ng.players, resolved: [] },
          }));
          Alert.alert(
            'SIRALAMA EŞİTLİĞİ (DEVAM)',
            `${ng.players.map(p => labels[p]).join(' - ')} hâlâ eşit.`
          );
          return;
        }

        updateModeState(activeMode, prev => ({
          ...prev,
          daily: updatedDaily,
          rounds: updatedRounds,
          overallUpdatedAt: nowISO(),
          selection: emptySelection(),
          placementGroup: { playerIdxs: activeGroup.playerIdxs, resolved },
        }));
        Alert.alert(
          'SIRALAMA EŞİTLİĞİ',
          `${labels[topInGroup[0]]} öne geçti. Kalanlar devam.`
        );
        return;
      }

      updateModeState(activeMode, prev => ({
        ...prev,
        daily: updatedDaily,
        rounds: updatedRounds,
        overallUpdatedAt: nowISO(),
        selection: emptySelection(),
      }));
      Alert.alert('BERABERLİK SÜRÜYOR', 'Grup içinde eşitlik var.');
      return;
    }

    /* ---- BİRİNCİLİK EŞİTLİK BOZMA ---- */
    if (state.tieBreak) {
      const leaders = leadersOf(updatedDaily);
      if (leaders.length === 1) {
        afterFirstPlaceResolved(updatedDaily, updatedRounds, leaders[0]);
        return;
      }
      updateModeState(activeMode, prev => ({
        ...prev,
        daily: updatedDaily,
        rounds: updatedRounds,
        overallUpdatedAt: nowISO(),
        selection: emptySelection(),
      }));
      Alert.alert('BERABERLİK SÜRÜYOR', 'Birincilikte eşitlik var.');
      return;
    }

    /* ---- NORMAL ---- */
    if (reachedTarget(updatedDaily)) {
      const leaders = leadersOf(updatedDaily);
      if (leaders.length > 1) {
        updateModeState(activeMode, prev => ({
          ...prev,
          daily: updatedDaily,
          rounds: updatedRounds,
          overallUpdatedAt: nowISO(),
          selection: emptySelection(),
          tieBreak: true,
        }));
        Alert.alert('BİRİNCİLİKTE BERABERLİK', 'Eşitlik bozulana kadar el oynanacak.');
        return;
      }
      afterFirstPlaceResolved(updatedDaily, updatedRounds, leaders[0]);
      return;
    }

    updateModeState(activeMode, prev => ({
      ...prev,
      daily: updatedDaily,
      rounds: updatedRounds,
      overallUpdatedAt: nowISO(),
      selection: emptySelection(),
    }));
  }

  /* ============================================================
     EL DÜZENLEME (mevcut seri)
  ============================================================ */
  function startEditCurrentRound(roundNo) {
    if (isViewer) return;
    const round = state.rounds.find(r => r.no === roundNo);
    if (!round) return;
    const sel = emptySelection();
    round.results.forEach(r => { sel[r.place - 1] = r.player; });
    setEditRound({ scope: 'current', roundNo, selection: sel });
  }

  function applyEditCurrentRound() {
    if (isViewer) return;
    const ed = editRound;
    if (!ed) return;
    if (ed.selection.some(x => x === null) || new Set(ed.selection).size !== 4) {
      Alert.alert('Hata', 'Dört sıranın da seçilmesi ve oyuncuların benzersiz olması gerek.');
      return;
    }

    const newRounds = state.rounds.map(r => {
      if (r.no !== ed.roundNo) return r;
      return {
        ...r,
        results: ed.selection.map((player, place) => ({
          player,
          place: place + 1,
          points: POINTS[place],
        })),
      };
    });

    const sim = simulateSeries(newRounds);

    updateModeState(activeMode, prev => {
      if (sim.finished && !prev.finished) {
        return finalizeSeriesState(prev, sim.daily, sim.rounds, sim.ranking).nextState;
      }
      return {
        ...prev,
        daily: sim.daily,
        rounds: sim.rounds,
        overallUpdatedAt: nowISO(),
        finished: sim.finished,
        winner: sim.winner,
        tieBreak: sim.tieBreak,
        placementTieBreak: sim.placementTieBreak,
        placementGroup: sim.placementGroup,
        selection: emptySelection(),
      };
    });

    setEditRound(null);
    Alert.alert('Güncellendi', `${ed.roundNo}. el yeniden hesaplandı.`);
  }

  /* ============================================================
     TAMAMLANAN SERİDE EL DÜZENLEME
  ============================================================ */
  function startEditHistoryRound(seriesId, roundNo) {
    if (isViewer) return;
    const series = state.completedSeries.find(s => s.id === seriesId);
    if (!series) return;
    const round = series.rounds.find(r => r.no === roundNo);
    if (!round) return;
    const sel = emptySelection();
    round.results.forEach(r => { sel[r.place - 1] = r.player; });
    setEditRound({ scope: 'history', seriesId, roundNo, selection: sel });
  }

  function applyEditHistoryRound() {
    if (isViewer) return;
    const ed = editRound;
    if (!ed) return;
    if (ed.selection.some(x => x === null) || new Set(ed.selection).size !== 4) {
      Alert.alert('Hata', 'Geçersiz seçim.');
      return;
    }

    updateModeState(activeMode, prev => {
      const series = prev.completedSeries.find(s => s.id === ed.seriesId);
      if (!series) return prev;

      const newRounds = series.rounds.map(r => {
        if (r.no !== ed.roundNo) return r;
        return {
          ...r,
          results: ed.selection.map((player, place) => ({
            player,
            place: place + 1,
            points: POINTS[place],
          })),
        };
      });

      const sim = simulateSeries(newRounds);
      const previousAwarded = series.awarded || emptyScores();
      const newAwarded = sim.finished ? sim.awarded : emptyScores();
      const newOrder = sim.finished ? sim.ranking : rankPlayers(sim.daily);
      const updatedAt = nowISO();

      const updatedOverall = prev.overall.map(
        (v, i) => v - previousAwarded[i] + newAwarded[i]
      );

      const newSeries = {
        ...series,
        rounds: sim.rounds,
        finalDaily: sim.daily,
        ranking: newOrder,
        awarded: newAwarded,
        winner: sim.winner,
        finished: sim.finished,
      };

      return {
        ...prev,
        overall: updatedOverall,
        overallUpdatedAt: updatedAt,
        completedSeries: prev.completedSeries.map(s =>
          s.id === ed.seriesId ? newSeries : s
        ),
      };
    });

    setEditRound(null);
    Alert.alert('Güncellendi', 'Seri ve genel puanlar yeniden hesaplandı.');
  }

  /* ============================================================
     RENDER: YÜKLENİYOR
  ============================================================ */
  if (!ready) {
    return (
      <SafeAreaView style={[styles.container, styles.loading]}>
        <ActivityIndicator size="large" color="#5BE0A4" />
        <Text style={styles.info}>Kayıtlar yükleniyor...</Text>
      </SafeAreaView>
    );
  }

  /* ============================================================
     1. AŞAMA: İLK AÇILIŞ SEÇİM EKRANI
     "Sen mi seri başlatmak istiyorsun?" / "Başkasının serisini mi takip etmek istiyorsun?"
  ============================================================ */
  if (screen === 'choice') {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.modeScreen}>
          <Text style={styles.headerTitle}>HAS ORTAKLAR</Text>
          <Text style={styles.headerSub}>Ne yapmak istiyorsun?</Text>

          <TouchableOpacity
            style={styles.choiceCardPrimary}
            onPress={() => setScreen('start_mode')}
          >
            <Text style={styles.choiceTitlePrimary}>
              Sen mi seri başlatmak istiyorsun?
            </Text>
            <Text style={styles.choiceSub}>
              Bugünün tarihiyle ({todayDateTR()}) yeni bir genel seri aç, puanları gir ve diğer arkadaşlarınla paylaş.
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.choiceCardSecondary}
            onPress={() => {
              if (!isFirebaseConfigured) {
                Alert.alert(
                  'Bulut bağlantısı gerekli',
                  'Başkasının serisini canlı takip edebilmek için App.js içindeki FIREBASE_CONFIG bilgilerini doldurmalısın.'
                );
                return;
              }
              setSearchFilter('');
              setScreen('watch_list');
            }}
          >
            <Text style={styles.choiceTitleSecondary}>
              Başkasının serisini mi takip etmek istiyorsun?
            </Text>
            <Text style={styles.choiceSub}>
              Paylaşılan aktif genel seriyi seç ve skorları canlı olarak takip et.
            </Text>
          </TouchableOpacity>

          {!isFirebaseConfigured && (
            <Text style={styles.warnText}>
              Not: Bulut paylaşımı için FIREBASE_CONFIG alanını doldurun.
            </Text>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  /* ============================================================
     2. AŞAMA: EŞLİ / TEKLİ MOD SEÇİMİ (ALTINDA İSİM YOK)
  ============================================================ */
  if (screen === 'start_mode') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.modeScreen}>
          <Text style={styles.headerTitle}>HAS ORTAKLAR</Text>
          <Text style={styles.headerSub}>Oyun modunu seç</Text>

          <TouchableOpacity style={styles.modeButton} onPress={() => chooseStartMode('team')}>
            <Text style={styles.modeButtonTitle}>EŞLİ</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.modeButton} onPress={() => chooseStartMode('single')}>
            <Text style={styles.modeButtonTitle}>TEKLİ</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setScreen('choice')}>
            <Text style={styles.cancelText}>GERİ DÖN</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  /* ============================================================
     3. AŞAMA: GÜN.AY.YIL TARİHİYLE GENEL SERİ BAŞLATMA EKRANI
  ============================================================ */
  if (screen === 'start_title') {
    const existing = store.byMode[setupMode];
    const hasExisting =
      existing &&
      (existing.overall.some(v => v !== 0) ||
        existing.completedSeries.length > 0 ||
        existing.rounds.length > 0);

    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.modeScreen}>
          <Text style={styles.headerTitle}>HAS ORTAKLAR</Text>
          <Text style={styles.headerSub}>
            {setupMode === 'team' ? 'EŞLİ GENEL SERİ BAŞLAT' : 'TEKLİ GENEL SERİ BAŞLAT'}
          </Text>

          <View style={[styles.card, { marginTop: 20 }]}>
            <Text style={styles.cardTitle}>Genel Seri Başlığı (Gün.Ay.Yıl)</Text>
            <Text style={styles.smallInfo}>
              Seri otomatik olarak bugünün tarihiyle ({todayDateTR()}) başlar. Diğer kullanıcılar bu isimle seriyi bulup takip edecektir.
            </Text>
            <TextInput
              style={styles.textInput}
              value={setupTitle}
              onChangeText={setSetupTitle}
              placeholder={defaultSeriesTitle(setupMode)}
              placeholderTextColor="#7D8FA3"
            />

            <TouchableOpacity
              style={styles.saveButton}
              onPress={() => launchGeneralSeries(false)}
            >
              <Text style={styles.saveText}>
                {hasExisting ? 'MEVCUT SERİYLE DEVAM ET VE PAYLAŞ' : 'GENEL SERİYİ BAŞLAT'}
              </Text>
            </TouchableOpacity>

            {hasExisting && (
              <TouchableOpacity
                style={styles.archiveButton}
                onPress={() => {
                  Alert.alert(
                    'Yeni Genel Seri Başlat',
                    `Önceki seri arşivlensin mi yoksa sıfırdan yeni seri mi açılsın?`,
                    [
                      { text: 'Vazgeç', style: 'cancel' },
                      {
                        text: 'Sıfırdan Başlat',
                        style: 'destructive',
                        onPress: () => launchGeneralSeries(true),
                      },
                    ]
                  );
                }}
              >
                <Text style={styles.saveText}>BUGÜNÜN TARİHİYLE YENİ SERİ AÇ</Text>
              </TouchableOpacity>
            )}
          </View>

          <TouchableOpacity onPress={() => setScreen('start_mode')}>
            <Text style={styles.cancelText}>GERİ DÖN</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  /* ============================================================
     TAKİP EKRANI: PAYLAŞILAN GENEL SERİ LİSTESİ (SALT OKUNUR)
  ============================================================ */
  if (screen === 'watch_list') {
    const qLower = searchFilter.trim().toLowerCase();
    const filteredList = qLower
      ? cloudSeriesList.filter(item => {
          const titleMatch = (item.title || '').toLowerCase().includes(qLower);
          const codeMatch = (item.shareCode || '').toLowerCase().includes(qLower);
          const dateMatch = (item.startDateTR || '').toLowerCase().includes(qLower);
          return titleMatch || codeMatch || dateMatch;
        })
      : cloudSeriesList;

    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>HAS ORTAKLAR</Text>
            <Text style={styles.headerSub}>TAKİP EDİLECEK GENEL SERİYİ SEÇ</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>📡 PAYLAŞILAN GENEL SERİLER</Text>
            <TextInput
              style={styles.textInput}
              value={searchFilter}
              onChangeText={setSearchFilter}
              placeholder="Tarih (25.11.2026), seri adı veya kod ile ara..."
              placeholderTextColor="#7D8FA3"
            />

            {syncStatus === 'syncing' && cloudSeriesList.length === 0 ? (
              <ActivityIndicator size="small" color="#5BE0A4" style={{ marginVertical: 16 }} />
            ) : filteredList.length === 0 ? (
              <Text style={styles.info}>
                Eşleşen paylaşılmış genel seri bulunamadı. Seri başlatan kişi seriyi açtığında burada otomatik listelenir.
              </Text>
            ) : (
              filteredList.map(item => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.completedRow}
                  onPress={() => startWatchingSeries(item)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.historyTitle}>
                      {item.title || defaultSeriesTitle(item.mode)}
                    </Text>
                    <Text style={styles.smallInfo}>
                      {item.mode === 'team' ? 'Eşli Mod' : 'Tekli Mod'} • Kod: {item.shareCode || '-'} • Son güncelleme: {formatDate(item.updatedAt)}
                    </Text>
                  </View>
                  <Text style={styles.detailLink}>TAKİP ET ›</Text>
                </TouchableOpacity>
              ))
            )}
          </View>

          <TouchableOpacity onPress={() => setScreen('choice')}>
            <Text style={styles.cancelText}>ANA EKRANA DÖN</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  /* ============================================================
     TABELA EKRANI (SERİ BAŞLATAN VEYA TAKİP EDEN)
  ============================================================ */
  const historyRecord = state.completedSeries.find(
    item => item.id === selectedHistory
  );
  const generalArchiveRecord = (state.archivedGeneralSeries || []).find(
    item => item.id === selectedGeneralArchive
  );
  const activePlacementGroup = normalizePlacementGroup(state.placementGroup);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>

        {/* BAŞLIK + MOD + PAYLAŞIM */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>HAS ORTAKLAR</Text>
          <Text style={styles.seriesBanner}>
            {state.seriesTitle || defaultSeriesTitle(activeMode)}
          </Text>
          <Text style={styles.headerSub}>
            {isTeam ? 'EŞLİ MOD' : 'TEKLİ MOD'} • GENEL SERİ {state.generalSeriesNo}
            {state.shareCode ? ` • KOD: ${state.shareCode}` : ''}
            {isViewer ? ' • CANLI TAKİP' : ''}
          </Text>

          {isFirebaseConfigured && (
            <Text style={styles.syncBadge}>
              {syncStatus === 'ok'
                ? (isViewer ? '● Canlı bağlantı aktif (Salt Okunur)' : '● Yayında • Diğer kullanıcılar takip edebilir')
                : syncStatus === 'syncing'
                ? '● Senkronize ediliyor...'
                : syncStatus === 'error'
                ? '● Bağlantı uyarısı (yerel devam ediyor)'
                : ''}
            </Text>
          )}

          {!isViewer && (
            <TouchableOpacity style={styles.shareBannerBtn} onPress={shareCurrentSeries}>
              <Text style={styles.shareBannerText}>📤 SERİYİ DİĞER KULLANICILARLA PAYLAŞ</Text>
            </TouchableOpacity>
          )}

          <View style={styles.headerActions}>
            <TouchableOpacity onPress={() => setScreen('choice')} style={styles.modeChangeBtn}>
              <Text style={styles.modeChangeText}>
                {isViewer ? 'SERİ LİSTESİ / ANA EKRAN' : 'ANA EKRAN / MOD DEĞİŞTİR'}
              </Text>
            </TouchableOpacity>

            {!isViewer && (
              <TouchableOpacity
                onPress={() => {
                  setRenameDraft(state.seriesTitle || defaultSeriesTitle(activeMode));
                  setRenameModalOpen(true);
                }}
                style={styles.modeChangeBtn}
              >
                <Text style={[styles.modeChangeText, { color: '#5BE0A4' }]}>SERİ ADINI DÜZENLE</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* GENEL SERİ */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🏆 GENEL SERİ {state.generalSeriesNo} SIRALAMASI</Text>
          {ranking.map((p, index) => (
            <View style={styles.scoreRow} key={p}>
              <Text style={styles.rank}>{index + 1}.</Text>
              <Text style={styles.playerName}>{labels[p]}</Text>
              <Text style={styles.totalPoint}>{state.overall[p]} P</Text>
            </View>
          ))}
          <Text style={styles.smallInfo}>
            Başlangıç: {formatDate(state.generalStartedAt)} • Son güncelleme: {formatDate(state.overallUpdatedAt)}
          </Text>

          {!isViewer && (
            <TouchableOpacity style={styles.archiveButton} onPress={archiveAndStartNewGeneralSeries}>
              <Text style={styles.saveText}>GENEL SERİYİ ARŞİVLE VE YENİ BAŞLAT</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* GÜNLÜK SERİ */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>📅 GÜNLÜK SERİ - {state.seriesNo}</Text>
          <Text style={styles.smallInfo}>Başlangıç: {formatDate(state.seriesStartedAt)}</Text>
          {labels.map((name, p) => (
            <View style={styles.dailyRow} key={name}>
              <Text style={styles.playerName}>{name}</Text>
              <View style={styles.progressBackground}>
                <View style={[styles.progress, {
                  width: `${Math.min(100, Math.max(0, state.daily[p] / TARGET * 100))}%`
                }]} />
              </View>
              <Text style={styles.dailyPoint}>{state.daily[p]} / {TARGET}</Text>
            </View>
          ))}

          {state.tieBreak && !state.finished && (
            <View style={styles.tieBox}>
              <Text style={styles.winnerText}>⚖️ BİRİNCİLİK EŞİTLİK BOZMA</Text>
            </View>
          )}
          {state.placementTieBreak && !state.finished && activePlacementGroup && (
            <View style={styles.tieBox}>
              <Text style={styles.winnerText}>
                ⚖️ SIRALAMA EŞİTLİĞİ: {activePlacementGroup.playerIdxs.map(p => labels[p]).join(' - ')}
              </Text>
            </View>
          )}
          {state.finished && state.winner !== null && state.winner !== undefined && (
            <View style={styles.winnerBox}>
              <Text style={styles.winnerText}>🏆 KAZANAN: {labels[state.winner]}</Text>
              <Text style={styles.smallInfo}>Bitiş: {formatDate(state.completedSeries[0]?.completedAt)}</Text>
            </View>
          )}
        </View>

        {/* EL GİRİŞİ (SADECE SERİ BAŞLATAN CİHAZDA) */}
        {!isViewer && !state.finished && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {state.tieBreak ? '🎯 BİRİNCİLİK EŞİTLİK BOZMA ELİ'
                : state.placementTieBreak ? '🎯 SIRALAMA EŞİTLİK BOZMA ELİ'
                : '🎯 YENİ ELİN SIRALAMASI'}
            </Text>
            {state.placementTieBreak && activePlacementGroup && (
              <Text style={styles.info}>
                Sadece {activePlacementGroup.playerIdxs.map(p => labels[p]).join(', ')} arasında sıralama.
              </Text>
            )}
            {POINTS.map((point, place) => (
              <TouchableOpacity
                key={place}
                style={styles.selectButton}
                onPress={() => setModal(place)}
              >
                <Text style={styles.placeText}>{place + 1}. SIRA</Text>
                <Text style={styles.selectedName}>
                  {state.selection[place] === null ? 'Seç' : labels[state.selection[place]]}
                </Text>
                <Text style={styles.pointText}>{point > 0 ? '+' : ''}{point} P</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.saveButton} onPress={saveRound}>
              <Text style={styles.saveText}>ELİ KAYDET</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* MEVCUT SERİ EL GEÇMİŞİ */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>📋 MEVCUT SERİ EL GEÇMİŞİ</Text>
          {state.rounds.length === 0 ? (
            <Text style={styles.info}>Henüz el yok.</Text>
          ) : (
            [...state.rounds].reverse().map(item => (
              <View style={styles.historyRow} key={item.no}>
                <View style={styles.historyHeader}>
                  <Text style={styles.historyTitle}>
                    {item.no}. EL
                    {item.isTieBreak ? ' • BİRİNCİLİK EB' : ''}
                    {item.isPlacementTieBreak ? ' • SIRALAMA EB' : ''}
                  </Text>
                  {!isViewer && (
                    <TouchableOpacity onPress={() => startEditCurrentRound(item.no)}>
                      <Text style={styles.editLink}>DÜZENLE</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <Text style={styles.smallInfo}>{formatDate(item.playedAt)}</Text>
                <Text style={styles.historyText}>
                  {item.results.map(r =>
                    `${r.place}. ${labels[r.player]} (${r.points > 0 ? '+' : ''}${r.points})`
                  ).join('   ')}
                </Text>
                <Text style={styles.smallInfo}>
                  Sonrası: {labels.map((n, i) => `${n}:${item.scoresAfter[i]}`).join('  ')}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* TAMAMLANAN GÜNLÜK SERİLER */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🗂️ TAMAMLANAN GÜNLÜK SERİLER</Text>
          {state.completedSeries.length === 0 ? (
            <Text style={styles.info}>Bu genel seride henüz tamamlanmış günlük seri yok.</Text>
          ) : (
            state.completedSeries.map(item => (
              <TouchableOpacity
                key={item.id}
                style={styles.completedRow}
                onPress={() => setSelectedHistory(item.id)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.historyTitle}>SERİ {item.no}</Text>
                  <Text style={styles.smallInfo}>Bitiş: {formatDate(item.completedAt)}</Text>
                  <Text style={styles.historyText}>
                    Kazanan: {item.winner !== null && item.winner !== undefined ? labels[item.winner] : 'Belirsiz'}
                  </Text>
                </View>
                <Text style={styles.detailLink}>DETAY ›</Text>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* ARŞİVLENMİŞ GENEL SERİLER */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>📦 ARŞİVLENMİŞ GENEL SERİLER</Text>
          {(!state.archivedGeneralSeries || state.archivedGeneralSeries.length === 0) ? (
            <Text style={styles.info}>Henüz arşivlenmiş genel seri yok.</Text>
          ) : (
            state.archivedGeneralSeries.map(arch => (
              <TouchableOpacity
                key={arch.id}
                style={styles.completedRow}
                onPress={() => setSelectedGeneralArchive(arch.id)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.historyTitle}>
                    {arch.title || `GENEL SERİ ${arch.no}`}
                  </Text>
                  <Text style={styles.smallInfo}>Arşiv: {formatDate(arch.archivedAt)}</Text>
                  <Text style={styles.historyText}>
                    Lider: {arch.winner !== null && arch.winner !== undefined ? `${labels[arch.winner]} (${arch.overall[arch.winner]} P)` : '-'}
                  </Text>
                </View>
                <Text style={styles.detailLink}>DETAY ›</Text>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* YENİ GÜNLÜK SERİ */}
        {!isViewer && state.finished && (
          <TouchableOpacity style={styles.newButton} onPress={newSeries}>
            <Text style={styles.saveText}>YENİ GÜNLÜK SERİ BAŞLAT</Text>
          </TouchableOpacity>
        )}

        {/* AKTİF MODU SIFIRLA */}
        {!isViewer && (
          <TouchableOpacity style={styles.resetButton} onPress={resetActiveMode}>
            <Text style={styles.resetText}>
              {isTeam ? 'EŞLİ MOD KAYITLARINI SIFIRLA' : 'TEKLİ MOD KAYITLARINI SIFIRLA'}
            </Text>
          </TouchableOpacity>
        )}

      </ScrollView>

      {/* SERİ ADI DÜZENLEME MODAL */}
      <Modal
        visible={renameModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setRenameModalOpen(false)}
      >
        <SafeAreaView style={styles.modalBackground}>
          <View style={styles.modalCard}>
            <Text style={styles.cardTitle}>GENEL SERİ ADINI DÜZENLE</Text>
            <TextInput
              style={styles.textInput}
              value={renameDraft}
              onChangeText={setRenameDraft}
              placeholder={defaultSeriesTitle(activeMode)}
              placeholderTextColor="#7D8FA3"
            />
            <TouchableOpacity style={styles.saveButton} onPress={saveSeriesTitle}>
              <Text style={styles.saveText}>KAYDET</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setRenameModalOpen(false)}>
              <Text style={styles.cancelText}>VAZGEÇ</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      {/* OYUNCU/TAKIM SEÇİM MODAL */}
      <Modal
        visible={!isViewer && modal !== -1}
        transparent
        animationType="slide"
        onRequestClose={() => setModal(-1)}
      >
        <SafeAreaView style={styles.modalBackground}>
          <View style={styles.modalCard}>
            <Text style={styles.cardTitle}>{modal + 1}. SIRAYA SEÇ</Text>
            {labels.map((name, p) => {
              const isCurrent = state.selection[modal] === p;
              const isUsedElsewhere = used.includes(p) && !isCurrent;
              return (
                <TouchableOpacity
                  key={name}
                  disabled={isUsedElsewhere}
                  style={[styles.playerOption, isUsedElsewhere && styles.disabledOption]}
                  onPress={() => choosePlayer(p)}
                >
                  <Text style={styles.optionText}>
                    {name}{isCurrent ? '  (mevcut)' : ''}
                  </Text>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity onPress={() => setModal(-1)}>
              <Text style={styles.cancelText}>VAZGEÇ</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      {/* EL DÜZENLEME MODAL */}
      <Modal
        visible={!isViewer && !!editRound}
        transparent
        animationType="slide"
        onRequestClose={() => setEditRound(null)}
      >
        <SafeAreaView style={styles.modalBackground}>
          <View style={styles.modalCard}>
            {editRound && (
              <>
                <Text style={styles.cardTitle}>
                  {editRound.roundNo}. ELİ DÜZENLE
                  {editRound.scope === 'history' ? ' (GEÇMİŞ SERİ)' : ''}
                </Text>
                <Text style={styles.smallInfo}>
                  Kaydettiğinde sonraki tüm puanlar yeniden hesaplanır.
                  {editRound.scope === 'history' ? ' Genel puanlar da otomatik düzeltilir.' : ''}
                </Text>
                {POINTS.map((point, place) => {
                  const selVal = editRound.selection[place];
                  const usedInEdit = editRound.selection.filter(x => x !== null);
                  return (
                    <View key={place} style={styles.editRow}>
                      <Text style={styles.placeText}>{place + 1}. ({point > 0 ? '+' : ''}{point})</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        {labels.map((name, p) => {
                          const isCur = selVal === p;
                          const isUsedElse = usedInEdit.includes(p) && !isCur;
                          return (
                            <TouchableOpacity
                              key={name}
                              disabled={isUsedElse}
                              style={[
                                styles.editChip,
                                isCur && styles.editChipActive,
                                isUsedElse && styles.disabledOption,
                              ]}
                              onPress={() => {
                                setEditRound(er => {
                                  if (!er) return er;
                                  const next = [...er.selection];
                                  for (let i = 0; i < next.length; i++) {
                                    if (i !== place && next[i] === p) next[i] = null;
                                  }
                                  next[place] = p;
                                  return { ...er, selection: next };
                                });
                              }}
                            >
                              <Text style={[styles.editChipText, isCur && { color: '#0B1A2A' }]}>
                                {name}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </ScrollView>
                    </View>
                  );
                })}
                <TouchableOpacity
                  style={styles.saveButton}
                  onPress={editRound.scope === 'current' ? applyEditCurrentRound : applyEditHistoryRound}
                >
                  <Text style={styles.saveText}>GÜNCELLE</Text>
                </TouchableOpacity>
              </>
            )}
            <TouchableOpacity onPress={() => setEditRound(null)}>
              <Text style={styles.cancelText}>VAZGEÇ</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      {/* GEÇMİŞ GÜNLÜK SERİ DETAY MODAL */}
      <Modal
        visible={!!historyRecord}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedHistory(null)}
      >
        <SafeAreaView style={styles.modalBackground}>
          <View style={styles.modalCard}>
            <ScrollView>
              {historyRecord && (
                <>
                  <Text style={styles.cardTitle}>📅 SERİ {historyRecord.no} DETAY</Text>
                  <Text style={styles.smallInfo}>Başlangıç: {formatDate(historyRecord.startedAt)}</Text>
                  <Text style={styles.smallInfo}>Bitiş: {formatDate(historyRecord.completedAt)}</Text>

                  <Text style={styles.sectionTitle}>Final günlük puanları</Text>
                  {rankPlayers(historyRecord.finalDaily).map((p, index) => (
                    <View style={styles.scoreRow} key={p}>
                      <Text style={styles.rank}>{index + 1}.</Text>
                      <Text style={styles.playerName}>{labels[p]}</Text>
                      <Text style={styles.totalPoint}>{historyRecord.finalDaily[p]} P</Text>
                    </View>
                  ))}

                  <Text style={styles.sectionTitle}>Genel tabloya eklenen puanlar</Text>
                  {(historyRecord.ranking || rankPlayers(historyRecord.finalDaily)).map((p, index) => {
                    const aw = historyRecord.awarded ? historyRecord.awarded[p] : 0;
                    return (
                      <View style={styles.scoreRow} key={p}>
                        <Text style={styles.rank}>{index + 1}.</Text>
                        <Text style={styles.playerName}>{labels[p]}</Text>
                        <Text style={styles.totalPoint}>
                          {aw > 0 ? '+' : ''}{aw} P
                        </Text>
                      </View>
                    );
                  })}

                  <Text style={styles.sectionTitle}>El sonuçları</Text>
                  {historyRecord.rounds.map(round => (
                    <View style={styles.historyRow} key={round.no}>
                      <View style={styles.historyHeader}>
                        <Text style={styles.historyTitle}>
                          {round.no}. EL
                          {round.isTieBreak ? ' • BİRİNCİLİK EB' : ''}
                          {round.isPlacementTieBreak ? ' • SIRALAMA EB' : ''}
                        </Text>
                        {!isViewer && (
                          <TouchableOpacity
                            onPress={() => startEditHistoryRound(historyRecord.id, round.no)}
                          >
                            <Text style={styles.editLink}>DÜZENLE</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                      <Text style={styles.smallInfo}>{formatDate(round.playedAt)}</Text>
                      <Text style={styles.historyText}>
                        {round.results.map(r =>
                          `${r.place}. ${labels[r.player]} (${r.points > 0 ? '+' : ''}${r.points})`
                        ).join('\n')}
                      </Text>
                      <Text style={styles.smallInfo}>
                        Sonrası: {labels.map((n, i) => `${n}:${round.scoresAfter[i]}`).join('  ')}
                      </Text>
                    </View>
                  ))}
                </>
              )}
            </ScrollView>
            <TouchableOpacity onPress={() => setSelectedHistory(null)}>
              <Text style={styles.cancelText}>KAPAT</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      {/* ARŞİVLENMİŞ GENEL SERİ DETAY MODAL */}
      <Modal
        visible={!!generalArchiveRecord}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedGeneralArchive(null)}
      >
        <SafeAreaView style={styles.modalBackground}>
          <View style={styles.modalCard}>
            <ScrollView>
              {generalArchiveRecord && (
                <>
                  <Text style={styles.cardTitle}>
                    📦 {generalArchiveRecord.title || `GENEL SERİ ${generalArchiveRecord.no} ARŞİV`}
                  </Text>
                  <Text style={styles.smallInfo}>Başlangıç: {formatDate(generalArchiveRecord.startedAt)}</Text>
                  <Text style={styles.smallInfo}>Arşivlenme: {formatDate(generalArchiveRecord.archivedAt)}</Text>

                  <Text style={styles.sectionTitle}>Genel Sıralama</Text>
                  {(generalArchiveRecord.ranking || rankPlayers(generalArchiveRecord.overall)).map((p, index) => (
                    <View style={styles.scoreRow} key={p}>
                      <Text style={styles.rank}>{index + 1}.</Text>
                      <Text style={styles.playerName}>{labels[p]}</Text>
                      <Text style={styles.totalPoint}>{generalArchiveRecord.overall[p]} P</Text>
                    </View>
                  ))}

                  <Text style={styles.sectionTitle}>
                    Tamamlanan Günlük Seriler ({generalArchiveRecord.completedSeries?.length || 0})
                  </Text>
                  {(generalArchiveRecord.completedSeries || []).length === 0 ? (
                    <Text style={styles.info}>Tamamlanmış günlük seri kaydı yok.</Text>
                  ) : (
                    generalArchiveRecord.completedSeries.map(cs => (
                      <View style={styles.historyRow} key={cs.id}>
                        <Text style={styles.historyTitle}>
                          GÜNLÜK SERİ {cs.no} • Kazanan: {cs.winner !== null && cs.winner !== undefined ? labels[cs.winner] : '-'}
                        </Text>
                        <Text style={styles.smallInfo}>Bitiş: {formatDate(cs.completedAt)}</Text>
                        <Text style={styles.historyText}>
                          {labels.map((n, i) => `${n}: ${cs.finalDaily[i]}P (${cs.awarded[i] > 0 ? '+' : ''}${cs.awarded[i]})`).join('  |  ')}
                        </Text>
                      </View>
                    ))
                  )}

                  {generalArchiveRecord.unfinishedDaily && (
                    <>
                      <Text style={styles.sectionTitle}>
                        Arşiv Anındaki Yarım Günlük Seri (Seri {generalArchiveRecord.unfinishedDaily.seriesNo})
                      </Text>
                      <Text style={styles.historyText}>
                        {labels.map((n, i) => `${n}: ${generalArchiveRecord.unfinishedDaily.daily[i]}P`).join('  |  ')}
                      </Text>
                    </>
                  )}
                </>
              )}
            </ScrollView>
            <TouchableOpacity onPress={() => setSelectedGeneralArchive(null)}>
              <Text style={styles.cancelText}>KAPAT</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

    </SafeAreaView>
  );
}

/* ============================================================
   STİLLER
============================================================ */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#101D2D' },
  loading: { justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, paddingBottom: 35 },
  header: { alignItems: 'center', paddingVertical: 20 },
  headerTitle: { color: '#FFFFFF', fontSize: 25, fontWeight: 'bold', textAlign: 'center' },
  seriesBanner: {
    color: '#5BE0A4', fontSize: 16, fontWeight: 'bold',
    marginTop: 6, textAlign: 'center',
  },
  headerSub: { color: '#AAB8C9', marginTop: 5, textAlign: 'center', fontSize: 13 },
  syncBadge: { color: '#8ED6B5', fontSize: 12, marginTop: 6 },
  shareBannerBtn: {
    backgroundColor: '#159966', paddingHorizontal: 16, paddingVertical: 10,
    borderRadius: 10, marginTop: 12,
  },
  shareBannerText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 13 },
  headerActions: {
    flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', marginTop: 8,
  },
  modeScreen: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  choiceCardPrimary: {
    backgroundColor: '#1D3046', borderRadius: 16, padding: 22,
    marginTop: 22, borderWidth: 2, borderColor: '#5BE0A4',
  },
  choiceCardSecondary: {
    backgroundColor: '#1D3046', borderRadius: 16, padding: 22,
    marginTop: 18, borderWidth: 2, borderColor: '#F5C45B',
  },
  choiceTitlePrimary: {
    color: '#5BE0A4', fontSize: 19, fontWeight: 'bold', textAlign: 'center',
  },
  choiceTitleSecondary: {
    color: '#F5C45B', fontSize: 19, fontWeight: 'bold', textAlign: 'center',
  },
  choiceSub: {
    color: '#AAB8C9', fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 19,
  },
  modeButton: {
    backgroundColor: '#1D3046', borderRadius: 14, padding: 22,
    marginTop: 18, borderWidth: 2, borderColor: '#2768B2',
  },
  modeButtonTitle: { color: '#5BE0A4', fontSize: 22, fontWeight: 'bold', textAlign: 'center' },
  modeChangeBtn: { marginHorizontal: 8, marginTop: 6, padding: 6 },
  modeChangeText: { color: '#F5C45B', fontWeight: 'bold', fontSize: 12 },
  warnText: {
    color: '#F5C45B', fontSize: 12, textAlign: 'center',
    marginTop: 20, lineHeight: 18,
  },
  textInput: {
    backgroundColor: '#30465F', color: '#FFFFFF',
    borderRadius: 10, padding: 14, fontSize: 15,
    marginTop: 6, marginBottom: 10,
  },
  card: { backgroundColor: '#1D3046', borderRadius: 14, padding: 16, marginBottom: 16 },
  cardTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: 'bold', marginBottom: 14 },
  scoreRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#34485E',
  },
  rank: { color: '#F5C45B', fontWeight: 'bold', width: 35 },
  playerName: { color: '#FFFFFF', fontSize: 15, fontWeight: '600', flex: 1 },
  totalPoint: { color: '#5BE0A4', fontWeight: 'bold', fontSize: 16 },
  dailyRow: { flexDirection: 'row', alignItems: 'center', marginTop: 17 },
  progressBackground: {
    flex: 1, height: 9, backgroundColor: '#394C60',
    borderRadius: 10, marginHorizontal: 9, overflow: 'hidden',
  },
  progress: { height: 9, backgroundColor: '#36C98B', borderRadius: 10 },
  dailyPoint: { color: '#FFFFFF', width: 75, textAlign: 'right', fontWeight: 'bold' },
  info: { color: '#AAB8C9', marginBottom: 12 },
  smallInfo: { color: '#AAB8C9', fontSize: 12, marginTop: 4, marginBottom: 8 },
  selectButton: {
    backgroundColor: '#30465F', borderRadius: 10, padding: 14,
    marginBottom: 9, flexDirection: 'row', alignItems: 'center',
  },
  placeText: { color: '#F5C45B', fontWeight: 'bold', width: 75 },
  selectedName: { color: '#FFFFFF', fontWeight: 'bold', flex: 1 },
  pointText: { color: '#5BE0A4', fontWeight: 'bold' },
  saveButton: {
    backgroundColor: '#159966', padding: 16, borderRadius: 10,
    alignItems: 'center', marginTop: 12,
  },
  archiveButton: {
    backgroundColor: '#2768B2', padding: 14, borderRadius: 10,
    alignItems: 'center', marginTop: 8,
  },
  saveText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 15 },
  historyRow: {
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#34485E',
  },
  historyHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  historyTitle: { color: '#F5C45B', fontWeight: 'bold', marginBottom: 5, flex: 1 },
  historyText: { color: '#FFFFFF', lineHeight: 22 },
  editLink: { color: '#5BE0A4', fontWeight: 'bold', marginLeft: 8 },
  winnerBox: { backgroundColor: '#145E45', borderRadius: 10, padding: 14, marginTop: 8 },
  tieBox: { backgroundColor: '#735A21', borderRadius: 10, padding: 14, marginTop: 8 },
  winnerText: { color: '#FFFFFF', fontWeight: 'bold', textAlign: 'center' },
  newButton: {
    backgroundColor: '#2768B2', padding: 16, borderRadius: 10,
    alignItems: 'center', marginBottom: 14,
  },
  resetButton: { alignItems: 'center', padding: 14 },
  resetText: { color: '#E58B8B', fontWeight: 'bold' },
  modalBackground: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center', padding: 20,
  },
  modalCard: {
    backgroundColor: '#1D3046', borderRadius: 16,
    padding: 20, maxHeight: '90%',
  },
  playerOption: {
    backgroundColor: '#30465F', padding: 16,
    borderRadius: 9, marginBottom: 9,
  },
  disabledOption: { opacity: 0.3 },
  optionText: { color: '#FFFFFF', fontWeight: 'bold', textAlign: 'center' },
  cancelText: {
    color: '#F5C45B', textAlign: 'center', padding: 15, fontWeight: 'bold',
  },
  completedRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#34485E',
  },
  detailLink: { color: '#5BE0A4', fontWeight: 'bold', marginLeft: 8 },
  sectionTitle: {
    color: '#FFFFFF', fontWeight: 'bold', marginTop: 18, marginBottom: 6,
  },
  editRow: { marginBottom: 10 },
  editChip: {
    backgroundColor: '#30465F', paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 8, marginRight: 8,
  },
  editChipActive: { backgroundColor: '#5BE0A4' },
  editChipText: { color: '#FFFFFF', fontWeight: 'bold' },
});