import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const size = 16;
const directions: Record<string, number> = { hoch: -size, runter: size, links: -1, rechts: 1, up: -size, down: size, left: -1, right: 1 };
const initial = () => ({ body: [133,132,131], food: 138, direction: 1, points: 0 });
const recordKey = "spechy.snake.best";

export default function Snake() {
  const [board, setBoard] = useState(initial);
  const [phase, setPhase] = useState("idle");
  const [language, setLanguage] = useState("de");
  const [session, setSession] = useState("");
  const [best, setBest] = useState(() => Number(localStorage.getItem(recordKey)) || 0);
  const turn = useRef(1);
  const game = useRef(board);

  useEffect(() => {
    if (!session) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    async function connect() {
      const off = await listen<[string,string]>("snake-input", ({payload: [id, word]}) => {
        if (!active || id !== session) return;
        if (word === "de" || word === "en") { setLanguage(word); setPhase("playing"); }
        else if (word === "closed") { setPhase("error"); setSession(""); }
        else if (directions[word] && directions[word] !== -game.current.direction) turn.current = directions[word];
      });
      if (!active) { off(); return; }
      unsubscribe = off;
      await invoke("snake_start", { session });
      if (!active) await invoke("snake_stop", { session });
    }
    void connect().catch(() => { if (active) { setPhase("error"); setSession(""); } });
    return () => { active = false; unsubscribe?.(); void invoke("snake_stop", { session }).catch(() => {}); };
  }, [session]);

  useEffect(() => {
    if (phase !== "playing") return;
    const timer = window.setInterval(() => {
      const {body, food, points} = game.current;
      const direction = turn.current;
      const head = body[0] + direction;
      const eats = head === food;
      const trail = eats ? body : body.slice(0,-1);
      if (head < 0 || head >= size*size || (Math.abs(direction) === 1 && Math.floor(head/size) !== Math.floor(body[0]/size)) || trail.includes(head)) {
        setSession(""); setPhase("over"); return;
      }
      const next = { body: [head,...trail], food, direction, points: points + Number(eats) };
      if (eats) {
        const free = Array.from({length:size*size}, (_,i) => i).filter(i => !next.body.includes(i));
        if (free.length) next.food = free[Math.floor(Math.random()*free.length)];
        else { next.food = -1; setSession(""); setPhase("won"); }
        const record = Math.max(next.points, Number(localStorage.getItem(recordKey)) || 0);
        localStorage.setItem(recordKey, String(record)); setBest(record);
      }
      game.current = next; setBoard(next);
    }, 900);
    return () => clearInterval(timer);
  }, [phase]);

  return <section style={{padding:24,maxWidth:540}}>
    <h1 className="page-title">Voice Snake</h1>
    <p>Steuere per Mikrofon und sammle die goldenen Punkte. Meide die Wand und deinen eigenen Schwanz.</p>
    <strong>Punkte {board.points} · Persönlicher Rekord {best}</strong>
    <svg viewBox="0 0 160 160" aria-label="Snake-Spielfeld" style={{display:"block",width:"min(100%, 52vh)",margin:"12px 0",background:"#152a28",borderRadius:8}}>
      {board.body.map((cell,i) => <rect key={cell} x={cell%size*10+0.5} y={Math.floor(cell/size)*10+0.5} width="9" height="9" rx="2" fill={i ? "#51b896" : "#c7ffe1"}/>)}
      {board.food >= 0 && <circle cx={board.food%size*10+5} cy={Math.floor(board.food/size)*10+5} r="3.5" fill="#ffd16f"/>}
    </svg>
    <p role="status">{{idle:"Bereit zum Start.", loading:"Mikrofon wird gestartet …", playing: language === "de" ? "Sag hoch, runter, links oder rechts." : "Sag up, down, left oder right.", over:"Runde beendet.", won:"Spielfeld gefüllt!", error:"Lokale Spracherkennung nicht verfügbar. Prüfe dein Standardmikrofon und das installierte deutsche oder englische Windows-Spracherkennungspaket."}[phase]}</p>
    <button className="btn" onClick={() => {
      if (session) { setSession(""); setPhase("idle"); return; }
      game.current = initial(); setBoard(game.current); turn.current = 1;
      setPhase("loading"); setSession(crypto.randomUUID());
    }}>{session ? "Runde beenden" : "Mit Mikrofon starten"}</button>
  </section>;
}
