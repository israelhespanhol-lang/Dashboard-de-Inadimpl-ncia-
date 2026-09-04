
(() => {
  const DAY = 86400000;

  function esc(v) {
    return String(v ?? "")
      .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
      .replaceAll('"',"&quot;").replaceAll("'","&#039;");
  }

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
    const s = String(value).trim();
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00:00Z" : s;
    const d = new Date(iso);
    return Number.isNaN(+d) ? null : d;
  }

  function startOfDayUTC(d) {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  function formatBRL(v) {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency", currency: "BRL", maximumFractionDigits: 0
    }).format(Number(v || 0));
  }

  function formatCompactBRL(v) {
    const n = Number(v || 0);
    if (n >= 1e9) return "R$ " + (n/1e9).toFixed(1).replace(".", ",") + " bi";
    if (n >= 1e6) return "R$ " + (n/1e6).toFixed(1).replace(".", ",") + " mi";
    if (n >= 1e3) return "R$ " + (n/1e3).toFixed(1).replace(".", ",") + " mil";
    return formatBRL(n);
  }

  function formatDate(d) {
    return new Intl.DateTimeFormat("pt-BR", { timeZone:"UTC" }).format(d);
  }

  function formatMonthYear(ms) {
    let t = new Intl.DateTimeFormat("pt-BR", {
      month:"short", year:"numeric", timeZone:"UTC"
    }).format(new Date(ms)).replace(".", "").replace(" de ", "/");
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function normalizeRow(row, i) {
    const due = parseDate(row.dueDate ?? row.vencimento ?? row.due_date);
    const paid = parseDate(row.paymentDate ?? row.dataPagamento ?? row.payment_date ?? row.date);
    let daysDelay = row.daysDelay ?? row.diasAtraso ?? row.delayDays;

    if (daysDelay == null && due && paid) {
      daysDelay = Math.round((startOfDayUTC(paid) - startOfDayUTC(due)) / DAY);
    }

    return {
      id: row.id ?? i + 1,
      client: row.client ?? row.cliente ?? row.customer ?? "Sem cliente",
      dueDate: due,
      paymentDate: paid ?? due ?? new Date(),
      amount: Number(row.amount ?? row.valor ?? row.value ?? 0),
      daysDelay: Number(daysDelay ?? 0),
      raw: row
    };
  }

  class CompoPaymentTimeline extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode:"open" });
      this._rows = [];
      this._filtered = [];
      this._progress = 0.35;
      this._playing = false;
      this._speed = 1;
      this._raf = null;
      this._lastTs = 0;
      this._domainStart = Date.UTC(2024, 9, 1);
      this._domainEnd = Date.UTC(2026, 9, 31);
      this._client = "all";
      this._rangeStart = null;
      this._rangeEnd = null;
      this._config = {
        logo: "assets/compo-logo.svg",
        truck: "assets/compo-truck.png",
        backgroundImage: "",
        title: "Linha do tempo de pagamentos",
        subtitle: "Cada entrega representa um compromisso. Juntos, cultivamos resultados.",
        onTimeLabel: "No prazo",
        lateLabel: "Em atraso"
      };
    }

    connectedCallback() {
      this.renderShell();
      this.bind();
      this.readAttributes();
      this.sync();
    }

    disconnectedCallback() {
      cancelAnimationFrame(this._raf);
    }

    set data(rows) {
      this._rows = (Array.isArray(rows) ? rows : []).map(normalizeRow)
        .filter(r => r.paymentDate && Number.isFinite(r.amount) && Number.isFinite(r.daysDelay));
      this.refreshDomainFromData();
      this.sync();
    }

    get data() { return this._rows.map(r => r.raw); }

    configure(config = {}) {
      this._config = { ...this._config, ...config };
      this.sync();
    }

    setData(rows) { this.data = rows; }

    play() {
      if (!this._playing) {
        this._playing = true;
        this._lastTs = performance.now();
        this.animate();
        this.updateControls();
      }
    }

    pause() {
      this._playing = false;
      cancelAnimationFrame(this._raf);
      this.updateControls();
    }

    reset() {
      this._progress = 0;
      this.updateTimeline();
      this.draw();
    }

    readAttributes() {
      const bg = this.getAttribute("background-image");
      const logo = this.getAttribute("logo");
      const truck = this.getAttribute("truck");
      if (bg) this._config.backgroundImage = bg;
      if (logo) this._config.logo = logo;
      if (truck) this._config.truck = truck;
    }

    refreshDomainFromData() {
      if (!this._rows.length) return;
      const times = this._rows.map(r => +r.paymentDate).filter(Number.isFinite);
      if (!times.length) return;
      let min = Math.min(...times);
      let max = Math.max(...times);
      const pad = Math.max(DAY * 20, (max-min) * 0.025);
      this._domainStart = min - pad;
      this._domainEnd = max + pad;
      this._rangeStart = new Date(this._domainStart).toISOString().slice(0,10);
      this._rangeEnd = new Date(this._domainEnd).toISOString().slice(0,10);
    }

    renderShell() {
      this.shadowRoot.innerHTML = `
        <style>
          :host{display:block;container-type:inline-size;color:#f4f8f5;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif}
          *{box-sizing:border-box}
          button,select,input{font:inherit}
          .root{position:relative;isolation:isolate;overflow:hidden;border-radius:16px;min-height:620px;background:
            radial-gradient(circle at 96% 38%,rgba(255,174,74,.42),transparent 20%),
            linear-gradient(180deg,#082d30 0%,#365351 40%,#4c5135 57%,#102d25 75%,#071c1a 100%)}
          .scene{position:absolute;inset:0;background-size:cover;background-position:center;opacity:.95;z-index:-3}
          .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(3,27,29,.60) 0%,rgba(3,22,21,.08) 39%,rgba(5,28,22,.12) 70%,rgba(2,21,19,.64) 100%);z-index:-2}
          .field{position:absolute;left:0;right:0;top:42%;bottom:16%;z-index:-1;background:
            repeating-linear-gradient(171deg,rgba(30,92,48,.16) 0 7px,rgba(6,42,27,.18) 7px 13px),
            linear-gradient(180deg,rgba(21,78,45,.12),rgba(8,39,29,.62))}
          .top{display:grid;grid-template-columns:minmax(340px,1.4fr) minmax(690px,2.4fr);gap:18px;padding:24px 28px 0;align-items:start}
          .brand{display:flex;gap:22px;align-items:center;min-width:0}
          .brand img{width:116px;height:94px;object-fit:contain}
          .vr{height:76px;width:1px;background:rgba(255,255,255,.17)}
          .heading h2{font-size:26px;line-height:1.1;margin:0 0 7px;font-weight:800;letter-spacing:-.3px}
          .heading p{margin:0;color:#d1ddd7;font-size:14px}
          .metrics{display:grid;grid-template-columns:repeat(4,minmax(135px,1fr));gap:10px}
          .card{height:78px;border:1px solid rgba(210,233,222,.15);background:linear-gradient(180deg,rgba(7,40,39,.82),rgba(4,29,28,.75));border-radius:11px;padding:11px 13px;display:flex;align-items:center;gap:11px;backdrop-filter:blur(7px)}
          .card small{display:block;font-size:11px;color:#dbe5e0;margin-bottom:5px}.card strong{font-size:23px;white-space:nowrap}.sub{font-size:11px;color:#8fb5a6;margin-left:6px}
          .icon{width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.14);display:grid;place-items:center;color:#d1ded7;flex:0 0 auto}.ball{width:21px;height:21px;border-radius:50%;flex:0 0 auto}.green{background:#16c979}.orange{background:#ff8b24}
          .filters{display:flex;justify-content:flex-end;gap:10px;padding:10px 28px 0}
          .select,.datebtn{height:45px;min-width:180px;border:1px solid rgba(210,233,222,.14);background:rgba(6,38,37,.76);border-radius:9px;color:#f3f8f5;padding:0 14px;outline:0}
          .datewrap{position:relative}.datepanel{position:absolute;right:0;top:51px;z-index:20;display:none;background:#082b29;border:1px solid rgba(255,255,255,.16);padding:12px;border-radius:10px;box-shadow:0 16px 35px rgba(0,0,0,.35);gap:8px}.datepanel.open{display:flex}.datepanel input{background:#0a3733;color:#fff;border:1px solid rgba(255,255,255,.15);padding:9px;border-radius:7px}
          .chart{position:relative;height:420px;margin-top:8px}.axislabel{position:absolute;left:35px;top:22px;color:#d3ddd8;font-size:12px}.svg{width:100%;height:100%;display:block;overflow:visible}
          .road{position:absolute;left:0;right:0;bottom:52px;height:56px;background:linear-gradient(#68706b,#2d3431 45%,#141a18);border-top:3px solid rgba(230,236,223,.55);border-bottom:1px solid rgba(0,0,0,.45)}
          .road:after{content:"";position:absolute;left:0;right:0;top:31px;border-top:3px dashed rgba(235,204,90,.75)}
          .truck{position:absolute;bottom:69px;left:5%;width:min(29%,480px);height:auto;z-index:6;filter:drop-shadow(0 7px 6px rgba(0,0,0,.38));pointer-events:auto;cursor:grab;will-change:left}
          .truck:active{cursor:grabbing}
          .sign{position:absolute;right:3%;bottom:92px;background:#0b342c;border:2px solid #94a299;border-radius:4px;padding:10px 16px;text-align:center;font-weight:700;font-size:11px;line-height:1.45;color:#dbe7df;box-shadow:0 5px 17px rgba(0,0,0,.35)}
          .controls{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(350px,1fr);gap:16px;padding:0 26px 18px;margin-top:-4px}
          .player,.legend{min-height:68px;border:1px solid rgba(210,233,222,.14);background:rgba(4,31,29,.82);border-radius:11px;backdrop-filter:blur(8px);display:flex;align-items:center}
          .player{padding:10px 12px;gap:10px}.pill{height:45px;border-radius:25px;border:1px solid rgba(255,255,255,.12);background:rgba(8,42,39,.9);color:#f4f7f5;padding:0 17px;cursor:pointer}.pill.play{color:#1cdd82;font-weight:750}.speedlabel{font-size:13px;margin-left:6px}.speed{width:43px;height:40px;border:0;background:transparent;color:#f5f7f5;border-radius:22px;cursor:pointer}.speed.active{background:#0c4b3c;color:#1bdd81;font-weight:800}
          .range{flex:1;min-width:100px;accent-color:#17ce79}.month{font-size:13px;font-weight:750;min-width:76px;text-align:right}
          .legend{justify-content:space-around;padding:10px 15px;gap:12px;font-size:12px;color:#c7d3cd;flex-wrap:wrap}.leg{display:flex;align-items:center;gap:8px}.ldot{width:18px;height:18px;border-radius:50%}
          .tooltip{position:absolute;display:none;pointer-events:none;z-index:30;background:rgba(3,24,23,.96);border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:9px 11px;min-width:195px;font-size:12px;line-height:1.4;box-shadow:0 12px 32px rgba(0,0,0,.35)}
          @container (max-width:1050px){.top{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(4,1fr)}.root{min-height:760px}.chart{height:390px}.controls{grid-template-columns:1fr}.filters{justify-content:flex-start}.truck{width:min(33%,440px)}}
          @container (max-width:680px){.root{min-height:900px}.top{padding:16px}.brand img{width:80px;height:65px}.vr{height:55px}.heading h2{font-size:20px}.metrics{grid-template-columns:repeat(2,1fr)}.filters{padding:9px 16px 0;flex-wrap:wrap}.select,.datebtn{min-width:140px;flex:1}.chart{height:410px}.controls{padding:0 10px 12px}.player{flex-wrap:wrap}.range{flex-basis:100%}.truck{width:42%;bottom:72px}.sign{display:none}}
        </style>

        <div class="root">
          <div class="scene"></div><div class="shade"></div><div class="field"></div>

          <div class="top">
            <div class="brand">
              <img class="logo" alt="COMPO EXPERT">
              <div class="vr"></div>
              <div class="heading"><h2></h2><p></p></div>
            </div>
            <div class="metrics">
              <div class="card"><div class="icon">◉</div><div><small>Total de pagamentos</small><strong data-kpi="total">0</strong></div></div>
              <div class="card"><span class="ball green"></span><div><small>No prazo</small><strong data-kpi="ontime">0</strong><span class="sub" data-kpi="ontimepct"></span></div></div>
              <div class="card"><span class="ball orange"></span><div><small>Em atraso</small><strong data-kpi="late">0</strong><span class="sub" data-kpi="latepct"></span></div></div>
              <div class="card"><div class="icon">R$</div><div><small>Valor total</small><strong data-kpi="value">R$ 0</strong></div></div>
            </div>
          </div>

          <div class="filters">
            <select class="select client"></select>
            <div class="datewrap">
              <button class="datebtn" type="button"></button>
              <div class="datepanel">
                <input class="datefrom" type="date" aria-label="Data inicial">
                <input class="dateto" type="date" aria-label="Data final">
              </div>
            </div>
          </div>

          <div class="chart">
            <div class="axislabel">Dias de atraso</div>
            <svg class="svg" viewBox="0 0 2000 420" preserveAspectRatio="none" aria-label="Linha do tempo de pagamentos"></svg>
            <div class="road"></div>
            <img class="truck" alt="Caminhão COMPO EXPERT">
            <div class="sign">SOLOS MAIS FÉRTEIS<br>COLHEITAS MAIS FORTES</div>
            <div class="tooltip"></div>
          </div>

          <div class="controls">
            <div class="player">
              <button class="pill play" type="button">▶ Continuar</button>
              <button class="pill reset" type="button">↻ Reiniciar</button>
              <span class="speedlabel">Velocidade:</span>
              <button class="speed" data-speed=".5" type="button">0.5x</button>
              <button class="speed active" data-speed="1" type="button">1x</button>
              <button class="speed" data-speed="2" type="button">2x</button>
              <button class="speed" data-speed="4" type="button">4x</button>
              <input class="range" type="range" min="0" max="1000" value="350" aria-label="Posição na linha do tempo">
              <div class="month"></div>
            </div>
            <div class="legend">
              <div class="leg"><span class="ldot green"></span>No prazo / antecipado</div>
              <div class="leg"><span class="ldot orange"></span>Em atraso</div>
              <div class="leg">Tamanho da bolha = valor do pagamento</div>
            </div>
          </div>
        </div>
      `;
    }

    bind() {
      const $ = s => this.shadowRoot.querySelector(s);
      this.els = {
        root: $(".root"), scene: $(".scene"), logo: $(".logo"), truck: $(".truck"),
        title: $(".heading h2"), subtitle: $(".heading p"), svg: $(".svg"),
        client: $(".client"), dateBtn: $(".datebtn"), datePanel: $(".datepanel"),
        dateFrom: $(".datefrom"), dateTo: $(".dateto"), play: $(".play"), reset: $(".reset"),
        range: $(".range"), month: $(".month"), tooltip: $(".tooltip"),
        speeds: [...this.shadowRoot.querySelectorAll(".speed")]
      };

      this.els.play.addEventListener("click", () => this._playing ? this.pause() : this.play());
      this.els.reset.addEventListener("click", () => this.reset());
      this.els.range.addEventListener("input", () => {
        this._progress = Number(this.els.range.value) / 1000;
        this.updateTimeline();
        this.draw();
      });

      // Drag and Drop do Caminhão
      let isDragging = false;
      let startX = 0;
      let startProgress = 0;
      
      this.els.truck.addEventListener("pointerdown", e => {
        isDragging = true;
        this.pause();
        startX = e.clientX;
        startProgress = this._progress;
        this.els.truck.style.cursor = "grabbing";
        this.els.truck.setPointerCapture(e.pointerId);
      });
      
      this.els.truck.addEventListener("pointermove", e => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const rect = this.els.svg.getBoundingClientRect();
        // A pista útil onde o caminhão anda tem 68% da largura (de 4% a 72%)
        const trackWidth = rect.width * 0.68;
        const dProgress = dx / trackWidth;
        
        this._progress = Math.max(0, Math.min(1, startProgress + dProgress));
        this.updateTimeline();
        this.draw();
      });
      
      const endDrag = (e) => {
        if (!isDragging) return;
        isDragging = false;
        this.els.truck.style.cursor = "";
        this.els.truck.releasePointerCapture(e.pointerId);
      };
      
      this.els.truck.addEventListener("pointerup", endDrag);
      this.els.truck.addEventListener("pointercancel", endDrag);

      this.els.speeds.forEach(b => b.addEventListener("click", () => {
        this._speed = Number(b.dataset.speed);
        this.updateControls();
      }));

      this.els.client.addEventListener("change", () => {
        this._client = this.els.client.value;
        this.sync();
        this.dispatchFilterChange();
      });

      this.els.dateBtn.addEventListener("click", () => this.els.datePanel.classList.toggle("open"));
      this.els.dateFrom.addEventListener("change", () => {
        this._rangeStart = this.els.dateFrom.value;
        this.sync();
        this.dispatchFilterChange();
      });
      this.els.dateTo.addEventListener("change", () => {
        this._rangeEnd = this.els.dateTo.value;
        this.sync();
        this.dispatchFilterChange();
      });
    }

    dispatchFilterChange() {
      this.dispatchEvent(new CustomEvent("filterchange", {
        bubbles:true, detail:{
          client:this._client,
          start:this._rangeStart,
          end:this._rangeEnd
        }
      }));
    }

    filteredRows() {
      let a = this._rangeStart ? Date.parse(this._rangeStart + "T00:00:00Z") : -Infinity;
      let b = this._rangeEnd ? Date.parse(this._rangeEnd + "T23:59:59Z") : Infinity;
      return this._rows.filter(r =>
        (this._client === "all" || r.client === this._client) &&
        +r.paymentDate >= a && +r.paymentDate <= b
      );
    }

    sync() {
      if (!this.shadowRoot || !this.els) return;
      this.els.logo.src = this._config.logo;
      this.els.truck.src = this._config.truck;
      this.els.title.textContent = this._config.title;
      this.els.subtitle.textContent = this._config.subtitle;
      this.els.scene.style.backgroundImage = this._config.backgroundImage ? `url("${this._config.backgroundImage}")` : "";

      const clients = [...new Set(this._rows.map(r => r.client))].sort((a,b)=>a.localeCompare(b,"pt-BR"));
      const current = this._client;
      this.els.client.innerHTML = `<option value="all">Todos os clientes</option>` +
        clients.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
      this.els.client.value = clients.includes(current) ? current : "all";
      this._client = this.els.client.value;

      if (this._rangeStart) this.els.dateFrom.value = this._rangeStart;
      if (this._rangeEnd) this.els.dateTo.value = this._rangeEnd;
      this.els.dateBtn.textContent =
        `${this._rangeStart ? this._rangeStart.split("-").reverse().join("/") : "Início"} - ${this._rangeEnd ? this._rangeEnd.split("-").reverse().join("/") : "Fim"}`;

      this._filtered = this.filteredRows();
      this.updateKPIs();
      this.updateControls();
      this.updateTimeline();
      this.draw();
    }

    updateKPIs() {
      const rows = this._filtered;
      const total = rows.length;
      const ontime = rows.filter(r => r.daysDelay <= 0).length;
      const late = total - ontime;
      const value = rows.reduce((s,r)=>s+r.amount,0);
      const pct = n => total ? (100*n/total).toFixed(1).replace(".",",")+"%" : "0%";

      const set = (name, val) => {
        const e = this.shadowRoot.querySelector(`[data-kpi="${name}"]`);
        if (e) e.textContent = val;
      };
      set("total", total);
      set("ontime", ontime);
      set("late", late);
      set("ontimepct", pct(ontime));
      set("latepct", pct(late));
      set("value", formatCompactBRL(value));
    }

    updateControls() {
      this.els.play.textContent = this._playing ? "Ⅱ  Pausar" : "▶  Continuar";
      this.els.speeds.forEach(b => b.classList.toggle("active", Number(b.dataset.speed) === this._speed));
    }

    updateTimeline() {
      this.els.range.value = Math.round(this._progress * 1000);
      const now = this._domainStart + this._progress * (this._domainEnd - this._domainStart);
      this.els.month.textContent = formatMonthYear(now);

      // Move truck along road. Width compensation keeps the front inside the chart.
      const left = 4 + this._progress * 68;
      this.els.truck.style.left = left + "%";
    }

    animate = (ts) => {
      if (!this._playing) return;
      if (!this._lastTs) this._lastTs = ts;
      const dt = ts - this._lastTs;
      this._lastTs = ts;
      this._progress += (dt / 32000) * this._speed;
      if (this._progress >= 1) {
        this._progress = 1;
        this.pause();
      }
      this.updateTimeline();
      this.draw();
      if (this._playing) this._raf = requestAnimationFrame(this.animate);
    }

    draw() {
      const svg = this.els.svg;
      const NS = "http://www.w3.org/2000/svg";
      svg.replaceChildren();

      const W = 2000, H = 420;
      const L = 108, R = 55, T = 28, B = 320;
      const minD = -40, maxD = 90;

      const currentMs = this._domainStart + this._progress * (this._domainEnd - this._domainStart);
      const x = ms => L + ((ms - this._domainStart)/(this._domainEnd-this._domainStart))*(W-L-R);
      const y = d => B - ((d-minD)/(maxD-minD))*(B-T);

      const mk = (tag, attrs={}) => {
        const el = document.createElementNS(NS, tag);
        for (const [k,v] of Object.entries(attrs)) el.setAttribute(k, v);
        return el;
      };

      // Horizontal axis / delay labels.
      [-40,-30,0,30,60,90].forEach(d => {
        const yy = y(d);
        const ln = mk("line", {x1:L,y1:yy,x2:W-R,y2:yy,
          stroke:d===0?"rgba(242,249,245,.82)":"rgba(224,239,230,.12)",
          "stroke-width":d===0?1.7:1, "stroke-dasharray":d===0?"8 6":"0"});
        svg.appendChild(ln);
        const tx = mk("text",{x:L-14,y:yy+5,"text-anchor":"end",fill:"rgba(243,248,245,.9)","font-size":"13"});
        tx.textContent = d > 0 ? "+"+d : d;
        svg.appendChild(tx);
      });

      // Date ticks every two months.
      const ds = new Date(this._domainStart);
      let yy = ds.getUTCFullYear(), mm = ds.getUTCMonth();
      mm = mm - (mm % 2);
      for (let guard=0; guard<30; guard++) {
        const ms = Date.UTC(yy,mm,1);
        if (ms > this._domainEnd) break;
        if (ms >= this._domainStart) {
          const xx = x(ms);
          svg.appendChild(mk("line",{x1:xx,y1:T,x2:xx,y2:B+65,stroke:"rgba(225,237,230,.16)","stroke-width":"1"}));
          const t = mk("text",{x:xx,y:B+94,"text-anchor":"middle",fill:"#f2f6f3","font-size":"13"});
          t.textContent = new Intl.DateTimeFormat("pt-BR",{month:"short",year:"2-digit",timeZone:"UTC"}).format(new Date(ms)).replace(".","");
          svg.appendChild(t);
        }
        mm += 2;
        if (mm > 11) { yy++; mm -= 12; }
      }

      // Future curtain and current cursor.
      const cx = x(currentMs);
      svg.appendChild(mk("rect",{x:cx,y:T,width:Math.max(0,W-R-cx),height:B-T,fill:"rgba(2,20,18,.13)"}));
      svg.appendChild(mk("line",{x1:cx,y1:T,x2:cx,y2:B+45,stroke:"rgba(236,255,246,.5)","stroke-width":"1"}));

      // Lollipop Chart
      const rect = svg.getBoundingClientRect();
      const scaleX = rect.width ? rect.width / 2000 : 1;
      const scaleY = rect.height ? rect.height / 420 : 1;
      
      const rows = this._filtered;
      const maxAmount = Math.max(1, ...rows.map(r => r.amount));
      const yZero = y(0);

      rows.forEach(r => {
        const isVisible = +r.paymentDate <= currentMs;
        const rr = 4 + Math.sqrt(Math.max(0,r.amount)/maxAmount)*14;
        
        const cx = x(+r.paymentDate);
        const cy = y(Math.max(minD,Math.min(maxD,r.daysDelay)));

        const c = mk("g", {});
        
        // Haste do Lollipop (Linha)
        const stem = mk("line", {
          x1: cx, y1: yZero,
          x2: cx, y2: cy,
          stroke: r.daysDelay > 0 ? "#ff8b24" : "#16c979",
          "stroke-opacity": isVisible ? ".5" : ".02",
          "stroke-width": 1.5 / scaleX
        });
        c.appendChild(stem);

        // Marcador do Lollipop
        const marker = mk("ellipse", {
          cx: cx, cy: cy,
          rx: rr / scaleX, ry: rr / scaleY,
          fill: r.daysDelay > 0 ? "#ff8b24" : "#16c979",
          "fill-opacity": isVisible ? ".95" : ".05",
          stroke: r.daysDelay > 0 ? "#ffbd75" : "#61e8a8",
          "stroke-opacity": isVisible ? ".95" : ".06",
          "stroke-width": 1.5 / Math.min(scaleX, scaleY)
        });
        c.appendChild(marker);

        if (isVisible) {
          c.style.cursor = "pointer";
          c.addEventListener("pointerenter", e => {
            const tip = this.els.tooltip;
            tip.style.display = "block";
            tip.innerHTML = `<strong>${esc(r.client)}</strong><br>
              Pagamento: ${formatDate(r.paymentDate)}<br>
              Status: ${r.daysDelay > 0 ? "Atraso" : "No prazo"} 
              (${r.daysDelay > 0 ? "+"+Math.round(r.daysDelay) : Math.abs(Math.round(r.daysDelay))} dias)<br>
              Valor Pago: ${formatBRL(r.amount)}`;
            let tLeft = e.clientX + 15;
            let tTop = e.clientY - 60;
            if (tLeft + 200 > window.innerWidth) tLeft = e.clientX - 215;
            tip.style.left = tLeft + "px";
            tip.style.top = tTop + "px";
          });
          c.addEventListener("pointerleave", () => {
            this.els.tooltip.style.display = "none";
          });
        }
        svg.appendChild(c);
      });
    }
  }

  if (!customElements.get("compo-payment-timeline")) {
    customElements.define("compo-payment-timeline", CompoPaymentTimeline);
  }
})();
