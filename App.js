import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Modal, SafeAreaView, Alert, ActivityIndicator, TextInput
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/* ============================================================
   SABİTLER
============================================================ */
const STORAGE_KEY = '@okey_seri_takip_v4';
const MODE_KEY = '@okey_seri_takip_v4_mode';

const SINGLE_PLAYERS = ['FATİH', 'SADIK', 'EMRE', 'NAZIM'];
const TEAM_NAMES = ['FATİH + SADIK', 'EMRE + NAZIM'];

const POINTS = [3, 2, 1, -1];
const TARGET = 15;

const emptyScores = () => [0, 0, 0, 0];
const emptySelection = () => [null, null, null, null];
const nowISO = () => new Date().toISOString();

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
  ranking.forEach((player, place) => { awarded[player] = POINTS[place]; });
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

/* ============================================================
   SİMÜLASYON: Bir seriyi baştan sona yeniden hesaplar.
   rounds: [{ no, playedAt, results: [{player, place, points}], isTieBreak, isPlacementTieBreak, placementGroup }]
   Döner: { daily, rounds (scoresAfter ile), finished, winner, tieBreak, placementTieBreak, placementGroup }
   NOT: Eşitlik bozma kararları (hangi elin tie-break olduğu) round üzerinde saklıdır;
   simülasyon sırasında bu bayraklar korunur, sadece puanlar yeniden hesaplanır.
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
    const scoresBefore = [...daily];

    // Puanları ekle
    r.results.forEach(res => {
      daily[res.player] += res.points;
    });

    const roundOut = {
      ...r,
      no: idx + 1,
      scoresAfter: [...daily],
    };
    outRounds.push(roundOut);

    // Durum makinesi
    if (r.isPlacementTieBreak && r.placementGroup) {
      const group = r.placementGroup;
      const groupScores = group.map(i => daily[i]);
      const maxInGroup = Math.max(...groupScores);
      const topInGroup = group.filter(i => daily[i] === maxInGroup);
      if (topInGroup.length === 1) {
        // Tek lider çıktı; sonraki ellerde kalan grup devam eder
        // Bu basitleştirilmiş simülasyonda, kalan grup varsa aynı gruptan devam
        const remaining = group.filter(i => i !== topInGroup[0]);
        if (remaining.length <= 1) {
          placementTieBreak = false;
          placementGroup = null;
        } else {
          placementGroup = { playerIdxs: remaining, resolved: [topInGroup[0]] };
        }
      }
      // Tek lider çıkmadıysa beraberlik sürüyor
      continue;
    }

    if (r.isTieBreak) {
      const leaders = leadersOf(daily);
      if (leaders.length === 1) {
        tieBreak = false;
        // Birincilik çözüldü → 2./3.lük beraberliğine bak
        const groups = placementTieGroups(daily, leaders[0]);
        if (groups.length > 0) {
          placementTieBreak = true;
          placementGroup = { playerIdxs: groups[0].players, resolved: [] };
        } else {
          finished = true;
          winner = leaders[0];
        }
      }
      continue;
    }

    // Normal el
    if (reachedTarget(daily)) {
      const leaders = leadersOf(daily);
      if (leaders.length > 1) {
        tieBreak = true;
      } else {
        // 2./3.lük beraberliği?
        const groups = placementTieGroups(daily, leaders[0]);
        if (groups.length > 0) {
          placementTieBreak = true;
          placementGroup = { playerIdxs: groups[0].players, resolved: [] };
        } else {
          finished = true;
          winner = leaders[0];
        }
      }
    }
  }

  return {
    daily, rounds: outRounds, finished, winner,
    tieBreak, placementTieBreak, placementGroup,
  };
}

/* ============================================================
   TARİH FORMAT
============================================================ */
function formatDate(value) {
  if (!value) return '-';
  try {
    const d = new Date(value);
    return d.toLocaleString('tr-TR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return '-'; }
}

/* ============================================================
   BAŞLANGIÇ DURUMU
============================================================ */
const makeInitialState = (mode) => ({
  mode: mode || 'single',
  overall: emptyScores(),
  daily: emptyScores(),
  selection: emptySelection(),
  rounds: [],
  completedSeries: [],
  seriesNo: 1,
  seriesStartedAt: nowISO(),
  overallUpdatedAt: nowISO(),
  finished: false,
  tieBreak: false,
  placementTieBreak: false,
  placementGroup: null,
  winner: null,
});

/* ============================================================
   ANA UYGULAMA
============================================================ */
export default function App() {
  const [mode, setMode] = useState(null); // null → seçim ekranı
  const [state, setState] = useState(() => makeInitialState('single'));
  const [modal, setModal] = useState(-1);
  const [selectedHistory, setSelectedHistory] = useState(null);
  const [editRound, setEditRound] = useState(null); // { scope:'current'|'history', roundNo, seriesId?, selection:[...] }
  const [ready, setReady] = useState(false);

  /* ---------- YÜKLEME ---------- */
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const savedMode = await AsyncStorage.getItem(MODE_KEY);
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (mounted) {
          if (saved) {
            const parsed = JSON.parse(saved);
            setState({ ...makeInitialState(parsed.mode), ...parsed });
            setMode(parsed.mode || 'single');
          } else if (savedMode) {
            setMode(savedMode);
            setState(makeInitialState(savedMode));
          }
        }
      } catch {
        Alert.alert('Kayıt okunamadı', 'Kayıtlı veriler yüklenirken sorun oluştu.');
      } finally {
        if (mounted) setReady(true);
      }
    })();
    return () => { mounted = false; };
  }, []);

  /* ---------- KAYDETME ---------- */
  useEffect(() => {
    if (!ready || !mode) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
    AsyncStorage.setItem(MODE_KEY, mode).catch(() => {});
  }, [state, ready, mode]);

  /* ---------- MOD SEÇİMİ ---------- */
  function selectMode(m) {
    if (state.completedSeries.length > 0 || state.rounds.length > 0 || state.overall.some(v => v !== 0)) {
      Alert.alert(
        'Mod değiştirilsin mi?',
        'Mevcut veriler bu moda ait. Yeni moda geçince mevcut veriler sıfırlanacak (geçmiş kayıtlar dahil). Devam edilsin mi?',
        [
          { text: 'Vazgeç', style: 'cancel' },
          {
            text: 'Geç', style: 'destructive',
            onPress: async () => {
              const fresh = makeInitialState(m);
              setMode(m);
              setState(fresh);
              await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fresh)).catch(() => {});
              await AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
            }
          }
        ]
      );
    } else {
      const fresh = makeInitialState(m);
      setMode(m);
      setState(fresh);
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fresh)).catch(() => {});
      AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
    }
  }

  /* ---------- ETİKETLER ---------- */
  const labels = mode === 'team' ? TEAM_NAMES : SINGLE_PLAYERS;
  const isTeam = mode === 'team';

  /* ---------- TÜRETİLMİŞ ---------- */
  const used = state.selection.filter(x => x !== null);
  const ranking = useMemo(() => rankPlayers(state.overall), [state.overall]);

  /* ---------- OYUNCU/TAKIM SEÇİMİ ---------- */
  function choosePlayer(playerIndex) {
    setState(prev => {
      const next = [...prev.selection];
      for (let i = 0; i < next.length; i++) {
        if (i !== modal && next[i] === playerIndex) next[i] = null;
      }
      next[modal] = playerIndex;
      return { ...prev, selection: next };
    });
    setModal(-1);
  }

  /* ---------- YENİ SERİ ---------- */
  function newSeries() {
    setState(prev => ({
      ...prev,
      daily: emptyScores(),
      selection: emptySelection(),
      rounds: [],
      seriesNo: prev.seriesNo + 1,
      seriesStartedAt: nowISO(),
      finished: false,
      tieBreak: false,
      placementTieBreak: false,
      placementGroup: null,
      winner: null,
    }));
    setSelectedHistory(null);
  }

  /* ---------- TÜMÜNÜ SIFIRLA ---------- */
  function resetAll() {
    Alert.alert(
      'Tüm kayıtlar silinsin mi?',
      'Günlük puanlar, genel puanlar ve geçmiş seriler sıfırlanacak.',
      [
        { text: 'Vazgeç', style: 'cancel' },
        {
          text: 'Tümünü sil', style: 'destructive',
          onPress: () => {
            Alert.alert('Emin misiniz?', 'Bu işlem geri alınamaz.', [
              { text: 'Hayır', style: 'cancel' },
              {
                text: 'Evet, sil', style: 'destructive',
                onPress: async () => {
                  const fresh = makeInitialState(mode);
                  setState(fresh);
                  setSelectedHistory(null);
                  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fresh)).catch(() => {});
                }
              }
            ]);
          }
        }
      ]
    );
  }

  /* ============================================================
     SERİYİ BİTİR (mevcut seri)
  ============================================================ */
  function finishSeries(finalScores, rounds, winnerIndex) {
    setState(prev => {
      const rest = [0, 1, 2, 3].filter(i => i !== winnerIndex);
      const restSorted = rest.sort((a, b) => {
        if (finalScores[b] !== finalScores[a]) return finalScores[b] - finalScores[a];
        return a - b;
      });
      const order = [winnerIndex, ...restSorted];
      const awarded = computeAwarded(order);
      const updatedOverall = prev.overall.map((v, i) => v + awarded[i]);

      const record = {
        id: `${prev.seriesNo}-${Date.now()}`,
        no: prev.seriesNo,
        mode: prev.mode,
        startedAt: prev.seriesStartedAt,
        completedAt: nowISO(),
        rounds,
        finalDaily: [...finalScores],
        ranking: order,
        awarded,
        winner: winnerIndex,
      };

      return {
        ...prev,
        overall: updatedOverall,
        overallUpdatedAt: nowISO(),
        daily: finalScores,
        rounds,
        completedSeries: [record, ...prev.completedSeries],
        finished: true,
        tieBreak: false,
        placementTieBreak: false,
        placementGroup: null,
        winner: winnerIndex,
        selection: emptySelection(),
      };
    });
    Alert.alert('GÜNLÜK SERİ TAMAMLANDI!', `${labels[winnerIndex]} günlük seriyi kazandı.`);
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
    setState(prev => ({
      ...prev,
      daily: finalScores,
      rounds,
      winner: winnerIndex,
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

    const round = {
      no: state.rounds.length + 1,
      playedAt: nowISO(),
      results: state.selection.map((player, place) => ({
        player, place: place + 1, points: POINTS[place]
      })),
      scoresAfter: [...updatedDaily],
      isTieBreak: state.tieBreak,
      isPlacementTieBreak: state.placementTieBreak,
      placementGroup: state.placementTieBreak && state.placementGroup
        ? [...state.placementGroup.playerIdxs] : null,
    };
    const updatedRounds = [...state.rounds, round];

    /* ---- SIRALAMA EŞİTLİK BOZMA ---- */
    if (state.placementTieBreak && state.placementGroup) {
      const group = state.placementGroup;
      const maxInGroup = Math.max(...group.playerIdxs.map(i => updatedDaily[i]));
      const topInGroup = group.playerIdxs.filter(i => updatedDaily[i] === maxInGroup);

      if (topInGroup.length === 1) {
        const resolved = [...group.resolved, topInGroup[0]];
        const remaining = group.playerIdxs.filter(i => !resolved.includes(i));

        if (remaining.length <= 1) {
          if (remaining.length === 1) resolved.push(remaining[0]);
          const winnerIdx = state.winner;
          const rest = [0, 1, 2, 3].filter(i => i !== winnerIdx && !resolved.includes(i));
          const restSorted = rest.sort((a, b) => {
            if (updatedDaily[b] !== updatedDaily[a]) return updatedDaily[b] - updatedDaily[a];
            return a - b;
          });
          const finalOrder = [winnerIdx, ...resolved, ...restSorted];

          // Başka beraberlik grubu var mı?
          const nextGroups = placementTieGroups(updatedDaily, winnerIdx)
            .filter(g => g.players.some(p => !resolved.includes(p)));

          if (nextGroups.length === 0) {
            finishSeriesWithOrder(updatedDaily, updatedRounds, finalOrder);
            return;
          }
          const ng = nextGroups[0];
          setState(prev => ({
            ...prev,
            daily: updatedDaily,
            rounds: updatedRounds,
            selection: emptySelection(),
            placementGroup: { playerIdxs: ng.players, resolved: [] },
          }));
          Alert.alert('SIRALAMA EŞİTLİĞİ (DEVAM)',
            `${ng.players.map(p => labels[p]).join(' - ')} hâlâ eşit.`);
          return;
        }

        setState(prev => ({
          ...prev,
          daily: updatedDaily,
          rounds: updatedRounds,
          selection: emptySelection(),
          placementGroup: { ...group, resolved },
        }));
        Alert.alert('SIRALAMA EŞİTLİĞİ',
          `${labels[topInGroup[0]]} öne geçti. Kalanlar devam.`);
        return;
      }

      setState(prev => ({
        ...prev,
        daily: updatedDaily,
        rounds: updatedRounds,
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
      setState(prev => ({
        ...prev,
        daily: updatedDaily,
        rounds: updatedRounds,
        selection: emptySelection(),
      }));
      Alert.alert('BERABERLİK SÜRÜYOR', 'Birincilikte eşitlik var.');
      return;
    }

    /* ---- NORMAL ---- */
    if (reachedTarget(updatedDaily)) {
      const leaders = leadersOf(updatedDaily);
      if (leaders.length > 1) {
        setState(prev => ({
          ...prev,
          daily: updatedDaily,
          rounds: updatedRounds,
          selection: emptySelection(),
          tieBreak: true,
        }));
        Alert.alert('BİRİNCİLİKTE BERABERLİK', 'Eşitlik bozulana kadar el oynanacak.');
        return;
      }
      afterFirstPlaceResolved(updatedDaily, updatedRounds, leaders[0]);
      return;
    }

    setState(prev => ({
      ...prev,
      daily: updatedDaily,
      rounds: updatedRounds,
      selection: emptySelection(),
    }));
  }

  /* ============================================================
     SIRALAMA NETLEŞTİĞİNDE BİTİR
  ============================================================ */
  function finishSeriesWithOrder(finalScores, rounds, finalOrder) {
    setState(prev => {
      const awarded = computeAwarded(finalOrder);
      const updatedOverall = prev.overall.map((v, i) => v + awarded[i]);
      const winnerIndex = finalOrder[0];
      const record = {
        id: `${prev.seriesNo}-${Date.now()}`,
        no: prev.seriesNo,
        mode: prev.mode,
        startedAt: prev.seriesStartedAt,
        completedAt: nowISO(),
        rounds,
        finalDaily: [...finalScores],
        ranking: finalOrder,
        awarded,
        winner: winnerIndex,
      };
      return {
        ...prev,
        overall: updatedOverall,
        overallUpdatedAt: nowISO(),
        daily: finalScores,
        rounds,
        completedSeries: [record, ...prev.completedSeries],
        finished: true,
        tieBreak: false,
        placementTieBreak: false,
        placementGroup: null,
        winner: winnerIndex,
        selection: emptySelection(),
      };
    });
    Alert.alert('GÜNLÜK SERİ TAMAMLANDI!', `${labels[finalOrder[0]]} kazandı.`);
  }

  /* ============================================================
     EL DÜZENLEME (mevcut seri)
  ============================================================ */
  function startEditCurrentRound(roundNo) {
    const round = state.rounds.find(r => r.no === roundNo);
    if (!round) return;
    const sel = emptySelection();
    round.results.forEach(r => { sel[r.place - 1] = r.player; });
    setEditRound({ scope: 'current', roundNo, selection: sel });
  }

  function applyEditCurrentRound() {
    const ed = editRound;
    if (!ed) return;
    if (ed.selection.some(x => x === null) || new Set(ed.selection).size !== 4) {
      Alert.alert('Hata', 'Dört sıranın da seçilmesi ve oyuncuların benzersiz olması gerek.');
      return;
    }
    // O elin results'ını değiştir, sonra simüle et
    const newRounds = state.rounds.map(r => {
      if (r.no !== ed.roundNo) return r;
      return {
        ...r,
        results: ed.selection.map((player, place) => ({
          player, place: place + 1, points: POINTS[place],
        })),
      };
    });
    const sim = simulateSeries(newRounds);
    // Genel seri düzenlenemez; sadece günlük seri ve durum yeniden hesaplanır
    setState(prev => ({
      ...prev,
      daily: sim.daily,
      rounds: sim.rounds,
      finished: sim.finished,
      winner: sim.winner,
      tieBreak: sim.tieBreak,
      placementTieBreak: sim.placementTieBreak,
      placementGroup: sim.placementGroup,
      selection: emptySelection(),
    }));
    setEditRound(null);
    Alert.alert('Güncellendi', `${ed.roundNo}. el yeniden hesaplandı.`);
  }

  /* ============================================================
     TAMAMLANAN SERİDE EL DÜZENLEME
  ============================================================ */
  function startEditHistoryRound(seriesId, roundNo) {
    const series = state.completedSeries.find(s => s.id === seriesId);
    if (!series) return;
    const round = series.rounds.find(r => r.no === roundNo);
    if (!round) return;
    const sel = emptySelection();
    round.results.forEach(r => { sel[r.place - 1] = r.player; });
    setEditRound({ scope: 'history', seriesId, roundNo, selection: sel });
  }

  function applyEditHistoryRound() {
    const ed = editRound;
    if (!ed) return;
    if (ed.selection.some(x => x === null) || new Set(ed.selection).size !== 4) {
      Alert.alert('Hata', 'Geçersiz seçim.');
      return;
    }
    setState(prev => {
      const series = prev.completedSeries.find(s => s.id === ed.seriesId);
      if (!series) return prev;

      // 1) O elin results'ını güncelle
      const newRounds = series.rounds.map(r => {
        if (r.no !== ed.roundNo) return r;
        return {
          ...r,
          results: ed.selection.map((player, place) => ({
            player, place: place + 1, points: POINTS[place],
          })),
        };
      });

      // 2) Simüle et → yeni finalDaily, ranking, winner, awarded
      const sim = simulateSeries(newRounds);

      // 3) Yeni sıralama: kazanan + kalanlar puana göre
      const winnerIdx = sim.winner;
      const rest = [0, 1, 2, 3].filter(i => i !== winnerIdx);
      const restSorted = rest.sort((a, b) => {
        if (sim.daily[b] !== sim.daily[a]) return sim.daily[b] - sim.daily[a];
        return a - b;
      });
      const newOrder = [winnerIdx, ...restSorted];
      const newAwarded = computeAwarded(newOrder);

      // 4) Genel tablodan eski awarded'ı çıkar, yenisini ekle
      const updatedOverall = prev.overall.map(
        (v, i) => v - series.awarded[i] + newAwarded[i]
      );

      // 5) Seri kaydını güncelle
      const newSeries = {
        ...series,
        rounds: sim.rounds,
        finalDaily: sim.daily,
        ranking: newOrder,
        awarded: newAwarded,
        winner: winnerIdx,
      };

      return {
        ...prev,
        overall: updatedOverall,
        overallUpdatedAt: nowISO(),
        completedSeries: prev.completedSeries.map(s =>
          s.id === ed.seriesId ? newSeries : s
        ),
      };
    });
    setEditRound(null);
    Alert.alert('Güncellendi', 'Seri ve genel puanlar yeniden hesaplandı.');
  }

  /* ============================================================
     RENDER
  ============================================================ */
  if (!ready) {
    return (
      <SafeAreaView style={[styles.container, styles.loading]}>
        <ActivityIndicator size="large" color="#5BE0A4" />
        <Text style={styles.info}>Kayıtlar yükleniyor...</Text>
      </SafeAreaView>
    );
  }

  /* --- MOD SEÇİM EKRANI --- */
  if (!mode) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.modeScreen}>
          <Text style={styles.headerTitle}>🀄 OKEY SERİ TAKİP</Text>
          <Text style={styles.headerSub}>Oyun modunu seç</Text>

          <TouchableOpacity style={styles.modeButton} onPress={() => selectMode('single')}>
            <Text style={styles.modeButtonTitle}>TEKLİ</Text>
            <Text style={styles.modeButtonSub}>
              4 oyuncu bireysel: {SINGLE_PLAYERS.join(', ')}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.modeButton} onPress={() => selectMode('team')}>
            <Text style={styles.modeButtonTitle}>EŞLİ</Text>
            <Text style={styles.modeButtonSub}>
              2 takım: {TEAM_NAMES.join('  /  ')}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const historyRecord = state.completedSeries.find(
    item => item.id === selectedHistory
  );
  const editSourceRounds = editRound
    ? (editRound.scope === 'current'
        ? state.rounds
        : state.completedSeries.find(s => s.id === editRound.seriesId)?.rounds || [])
    : [];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>

        {/* BAŞLIK + MOD */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>🀄 OKEY SERİ TAKİP</Text>
          <Text style={styles.headerSub}>
            {isTeam ? 'EŞLİ MOD' : 'TEKLİ MOD'}
          </Text>
          <TouchableOpacity onPress={() => setMode(null)} style={styles.modeChangeBtn}>
            <Text style={styles.modeChangeText}>MOD DEĞİŞTİR</Text>
          </TouchableOpacity>
        </View>

        {/* GENEL SERİ */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🏆 GENEL SERİ SIRALAMASI</Text>
          {ranking.map((p, index) => (
            <View style={styles.scoreRow} key={p}>
              <Text style={styles.rank}>{index + 1}.</Text>
              <Text style={styles.playerName}>{labels[p]}</Text>
              <Text style={styles.totalPoint}>{state.overall[p]} P</Text>
            </View>
          ))}
          <Text style={styles.smallInfo}>
            Son güncelleme: {formatDate(state.overallUpdatedAt)}
          </Text>
          <Text style={styles.smallInfo}>
            Genel puanlar yeni seride sıfırlanmaz. (Genel seri doğrudan düzenlenemez; seri düzenlemeleri otomatik yansır.)
          </Text>
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
          {state.placementTieBreak && !state.finished && state.placementGroup && (
            <View style={styles.tieBox}>
              <Text style={styles.winnerText}>
                ⚖️ SIRALAMA EŞİTLİĞİ: {state.placementGroup.playerIdxs.map(p => labels[p]).join(' - ')}
              </Text>
            </View>
          )}
          {state.finished && (
            <View style={styles.winnerBox}>
              <Text style={styles.winnerText}>🏆 KAZANAN: {labels[state.winner]}</Text>
              <Text style={styles.smallInfo}>Bitiş: {formatDate(state.completedSeries[0]?.completedAt)}</Text>
            </View>
          )}
        </View>

        {/* EL GİRİŞİ */}
        {!state.finished && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {state.tieBreak ? '🎯 BİRİNCİLİK EŞİTLİK BOZMA ELİ'
                : state.placementTieBreak ? '🎯 SIRALAMA EŞİTLİK BOZMA ELİ'
                : '🎯 YENİ ELİN SIRALAMASI'}
            </Text>
            {state.placementTieBreak && state.placementGroup && (
              <Text style={styles.info}>
                Sadece {state.placementGroup.playerIdxs.map(p => labels[p]).join(', ')} arasında sıralama.
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

        {/* MEVCUT SERİ EL GEÇMİŞİ (DÜZENLENEBİLİR) */}
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
                  <TouchableOpacity onPress={() => startEditCurrentRound(item.no)}>
                    <Text style={styles.editLink}>DÜZENLE</Text>
                  </TouchableOpacity>
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

        {/* TAMAMLANAN SERİLER */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>🗂️ TAMAMLANAN SERİLER</Text>
          {state.completedSeries.length === 0 ? (
            <Text style={styles.info}>Henüz tamamlanmış seri yok.</Text>
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
                  <Text style={styles.historyText}>Kazanan: {labels[item.winner]}</Text>
                </View>
                <Text style={styles.detailLink}>DETAY ›</Text>
              </TouchableOpacity>
            ))
          )}
        </View>

        {/* YENİ SERİ */}
        {state.finished && (
          <TouchableOpacity style={styles.newButton} onPress={newSeries}>
            <Text style={styles.saveText}>YENİ GÜNLÜK SERİ BAŞLAT</Text>
          </TouchableOpacity>
        )}

        {/* SIFIRLA */}
        <TouchableOpacity style={styles.resetButton} onPress={resetAll}>
          <Text style={styles.resetText}>TÜM KAYITLARI SIFIRLA</Text>
        </TouchableOpacity>

      </ScrollView>

      {/* OYUNCU/TAKIM SEÇİM MODAL */}
      <Modal
        visible={modal !== -1}
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
        visible={!!editRound}
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

      {/* GEÇMİŞ SERİ DETAY MODAL (DÜZENLENEBİLİR) */}
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
                  {historyRecord.ranking.map((p, index) => (
                    <View style={styles.scoreRow} key={p}>
                      <Text style={styles.rank}>{index + 1}.</Text>
                      <Text style={styles.playerName}>{labels[p]}</Text>
                      <Text style={styles.totalPoint}>
                        {historyRecord.awarded[p] > 0 ? '+' : ''}{historyRecord.awarded[p]} P
                      </Text>
                    </View>
                  ))}

                  <Text style={styles.sectionTitle}>El sonuçları</Text>
                  {historyRecord.rounds.map(round => (
                    <View style={styles.historyRow} key={round.no}>
                      <View style={styles.historyHeader}>
                        <Text style={styles.historyTitle}>
                          {round.no}. EL
                          {round.isTieBreak ? ' • BİRİNCİLİK EB' : ''}
                          {round.isPlacementTieBreak ? ' • SIRALAMA EB' : ''}
                        </Text>
                        <TouchableOpacity
                          onPress={() => startEditHistoryRound(historyRecord.id, round.no)}
                        >
                          <Text style={styles.editLink}>DÜZENLE</Text>
                        </TouchableOpacity>
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
  header: { alignItems: 'center', paddingVertical: 22 },
  headerTitle: { color: '#FFFFFF', fontSize: 25, fontWeight: 'bold', textAlign: 'center' },
  headerSub: { color: '#AAB8C9', marginTop: 7, textAlign: 'center' },
  modeScreen: { flex: 1, justifyContent: 'center', padding: 24 },
  modeButton: {
    backgroundColor: '#1D3046', borderRadius: 14, padding: 22,
    marginTop: 18, borderWidth: 2, borderColor: '#2768B2',
  },
  modeButtonTitle: { color: '#5BE0A4', fontSize: 22, fontWeight: 'bold', textAlign: 'center' },
  modeButtonSub: { color: '#AAB8C9', marginTop: 8, textAlign: 'center' },
  modeChangeBtn: { marginTop: 10, padding: 8 },
  modeChangeText: { color: '#F5C45B', fontWeight: 'bold' },
  card: { backgroundColor: '#1D3046', borderRadius: 14, padding: 16, marginBottom: 16 },
  cardTitle: { color: '#FFFFFF', fontSize: 17, fontWeight: 'bold', marginBottom: 16 },
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