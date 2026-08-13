export const INSPECTOR_SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  const BYTES_PER_ROW = 16;
  let payload = window.__NCS_PAYLOAD__;
  let bytes = new Uint8Array(0);
  let inspection = { header: { present: false, size: 0, parts: [] }, instructions: [] };
  let actions = [];
  let compat = {};
  let ndb = null;
  let labels = {};
  let instructionByCodeOffset = {};
  let byteInfo = [];
  let headerParts = [];
  let instructions = [];
  let saved = vscode.getState() || {};
  let layout = saved.layout || "split";
  let splitRatio = typeof saved.splitRatio === "number" ? saved.splitRatio : 0.48;
  let detailsCollapsed = !!saved.detailsCollapsed;
  let functionsOpen = !!saved.functionsOpen;
  let searchQuery = saved.searchQuery || "";
  let selectedInstructionIndex;
  let selectedPartIndex;
  let selectedHeader = false;
  let selectedHeaderPartIndex;
  let matches = [];
  let matchIndex = -1;

  const assemblyEl = document.getElementById("assembly");
  const bytecodeEl = document.getElementById("bytecode");
  const detailsEl = document.getElementById("details");
  const dividerEl = document.getElementById("divider");
  const workspaceEl = document.getElementById("workspace");
  const errorEl = document.getElementById("inspect-error");
  const functionsEl = document.getElementById("functions");
  const searchEl = document.getElementById("search");
  const searchMetaEl = document.getElementById("search-meta");

  function persist() {
    vscode.setState({
      layout: layout,
      splitRatio: splitRatio,
      detailsCollapsed: detailsCollapsed,
      functionsOpen: functionsOpen,
      searchQuery: searchQuery,
      selectedInstructionIndex: selectedInstructionIndex,
      selectedPartIndex: selectedPartIndex
    });
  }

  function padHex(value, width) {
    let text = (value >>> 0).toString(16).toUpperCase();
    while (text.length < width) text = "0" + text;
    return text;
  }

  function fromBase64(value) {
    const binary = atob(value || "");
    const result = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) result[i] = binary.charCodeAt(i);
    return result;
  }

  function asciiChar(value) {
    return value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : ".";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function displayParts(ins) {
    return (ins.parts || []).filter(function (part) {
      return part.kind !== "opcode" && part.kind !== "aux";
    });
  }

  function actionInfo(id) {
    for (let i = 0; i < actions.length; i += 1) {
      if (actions[i].actionId === id) return actions[i];
    }
    return undefined;
  }

  function ndbLineFor(ins) {
    if (!ndb || !ndb.lines || !ins) return undefined;
    for (let i = 0; i < ndb.lines.length; i += 1) {
      const line = ndb.lines[i];
      if (ins.fileOffset >= line.fileOffsetStart && ins.fileOffset < line.fileOffsetEnd) return line;
    }
    return undefined;
  }

  function ndbFunctionFor(ins) {
    if (!ndb || !ndb.functions || !ins) return undefined;
    for (let i = 0; i < ndb.functions.length; i += 1) {
      const fn = ndb.functions[i];
      if (ins.fileOffset >= fn.fileOffsetStart && ins.fileOffset < fn.fileOffsetEnd) return fn;
    }
    return undefined;
  }

  function rebuildDerived() {
    labels = {};
    instructionByCodeOffset = {};
    instructions = inspection.instructions || [];
    headerParts = (inspection.header && inspection.header.parts) || [];
    for (let i = 0; i < instructions.length; i += 1) {
      const ins = instructions[i];
      if (ins.index == null) ins.index = i;
      instructionByCodeOffset[ins.codeOffset] = ins;
      if (ins.jumpTarget == null) continue;
      const part = (ins.parts || []).find(function (item) { return item.kind === "address"; });
      if (part && part.text) labels[ins.jumpTarget] = part.text;
    }
    byteInfo = new Array(bytes.length);
    for (let i = 0; i < headerParts.length; i += 1) {
      const part = headerParts[i];
      for (let offset = part.fileOffset; offset < part.fileOffset + part.length && offset < bytes.length; offset += 1) {
        byteInfo[offset] = { header: true, headerPartIndex: i, kind: "header" };
      }
    }
    for (let i = 0; i < instructions.length; i += 1) {
      const ins = instructions[i];
      for (let offset = ins.fileOffset; offset < ins.fileOffset + ins.size && offset < bytes.length; offset += 1) {
        const current = byteInfo[offset] || {};
        byteInfo[offset] = { header: false, instructionIndex: ins.index, kind: current.kind || "unknown" };
      }
      const parts = ins.parts || [];
      for (let p = 0; p < parts.length; p += 1) {
        const part = parts[p];
        for (let offset = part.fileOffset; offset < part.fileOffset + part.length && offset < bytes.length; offset += 1) {
          byteInfo[offset] = { header: false, instructionIndex: ins.index, partIndex: p, kind: part.kind };
        }
      }
    }
  }

  function byteTitle(offset, info) {
    const parts = ["0x" + padHex(offset, 8)];
    if (info.header) {
      const part = info.headerPartIndex != null ? headerParts[info.headerPartIndex] : undefined;
      parts.push("header");
      if (part && part.text) parts.push(part.text);
      return parts.join(" · ");
    }
    if (info.instructionIndex != null) {
      const ins = instructions[info.instructionIndex];
      if (ins) parts.push(ins.mnemonic);
      if (info.partIndex != null && ins && ins.parts && ins.parts[info.partIndex]) {
        const part = ins.parts[info.partIndex];
        parts.push(part.kind);
        if (part.text) parts.push(part.text);
      }
    }
    return parts.join(" · ");
  }

  function renderAssembly() {
    const html = [];
    for (let i = 0; i < instructions.length; i += 1) {
      const ins = instructions[i];
      if (labels[ins.codeOffset]) {
        html.push('<div class="label">' + escapeHtml(labels[ins.codeOffset]) + ':</div>');
      }
      html.push(
        '<div class="instruction" data-index="' + ins.index +
        '" data-code-offset="' + ins.codeOffset +
        '" data-file-offset="' + ins.fileOffset + '">' +
        '<span class="address">' + padHex(ins.codeOffset, 8) + '</span>' +
        '<span class="mnemonic">' + escapeHtml(ins.mnemonic) + '</span>'
      );
      const parts = ins.parts || [];
      for (let p = 0; p < parts.length; p += 1) {
        const part = parts[p];
        if (part.kind === "opcode" || part.kind === "aux") continue;
        const extra = part.kind === "address" ? " jump-target" : "";
        let title = part.kind + (part.text ? ": " + part.text : "");
        if (part.kind === "actionId" && ins.actionId != null) {
          const info = actionInfo(ins.actionId);
          if (info) title = info.signature + " · ID " + ins.actionId;
          else if (ins.actionName) title = ins.actionName + " · ID " + ins.actionId;
        }
        html.push(
          '<span class="operand kind-' + part.kind + extra + '" data-part-index="' + p +
          '" title="' + escapeHtml(title) + '">' +
          escapeHtml(part.text || "") + "</span>"
        );
      }
      html.push("</div>");
    }
    assemblyEl.innerHTML = html.join("") || '<div class="muted" style="padding:12px">No instructions.</div>';
  }

  function renderBytecode() {
    const html = [];
    for (let offset = 0; offset < bytes.length; offset += BYTES_PER_ROW) {
      const hex = [];
      const ascii = [];
      const rowEnd = Math.min(offset + BYTES_PER_ROW, bytes.length);
      for (let i = offset; i < rowEnd; i += 1) {
        const info = byteInfo[i] || {};
        const kind = info.kind || "unknown";
        hex.push(
          '<span class="byte kind-' + kind + '" data-offset="' + i +
          '" title="' + escapeHtml(byteTitle(i, info)) + '">' + padHex(bytes[i], 2) + "</span>"
        );
        ascii.push(
          '<span class="ascii-byte kind-' + kind + '" data-offset="' + i + '">' +
          escapeHtml(asciiChar(bytes[i])) + "</span>"
        );
      }
      html.push(
        '<div class="hex-row">' +
        '<span class="address">' + padHex(offset, 8) + "</span>" +
        '<span class="hex-bytes">' + hex.join("") + "</span>" +
        '<span class="ascii">|' + ascii.join("") + "|</span>" +
        "</div>"
      );
    }
    bytecodeEl.innerHTML = html.join("");
  }

  function renderFunctions() {
    const items = [];
    const seen = {};
    if (ndb && ndb.functions) {
      for (let i = 0; i < ndb.functions.length; i += 1) {
        const fn = ndb.functions[i];
        const key = fn.label + "@" + fn.codeOffsetStart;
        if (seen[key]) continue;
        seen[key] = true;
        items.push({ name: fn.label, offset: fn.codeOffsetStart });
      }
    }
    for (let target in labels) {
      if (!Object.prototype.hasOwnProperty.call(labels, target)) continue;
      const name = labels[target];
      if (name.indexOf("fn_") !== 0 || seen[name]) continue;
      seen[name] = true;
      items.push({ name: name, offset: Number(target) });
    }
    items.sort(function (a, b) { return a.offset - b.offset; });
    if (!items.length) {
      functionsEl.innerHTML = '<div class="muted" style="padding:8px">No fn_ labels.</div>';
      return;
    }
    functionsEl.innerHTML = items.map(function (item) {
      return '<button type="button" class="fn-item" data-code-offset="' + item.offset + '">' +
        escapeHtml(item.name) + "</button>";
    }).join("");
  }

  function clearHighlights() {
    const selected = document.querySelectorAll(".instruction.selected, .in-range, .selected-field, .search-hit, .fn-item.active");
    for (let i = 0; i < selected.length; i += 1) {
      selected[i].classList.remove("selected", "in-range", "selected-field", "search-hit", "active");
    }
  }

  function highlightRange(start, length, strong) {
    for (let offset = start; offset < start + length; offset += 1) {
      const nodes = document.querySelectorAll('[data-offset="' + offset + '"]');
      for (let i = 0; i < nodes.length; i += 1) {
        nodes[i].classList.add(strong ? "selected-field" : "in-range");
      }
    }
  }

  function applySelection() {
    clearHighlights();
    if (matches.length) {
      for (let i = 0; i < matches.length; i += 1) {
        const hit = assemblyEl.querySelector('.instruction[data-index="' + matches[i] + '"]');
        if (hit) hit.classList.add("search-hit");
      }
    }
    if (selectedHeader) {
      const header = inspection.header || {};
      highlightRange(0, header.size || 0, false);
      if (selectedHeaderPartIndex != null && headerParts[selectedHeaderPartIndex]) {
        const part = headerParts[selectedHeaderPartIndex];
        highlightRange(part.fileOffset, part.length, true);
      }
      updateDetails();
      return;
    }
    if (selectedInstructionIndex == null) {
      updateDetails();
      return;
    }
    const ins = instructions[selectedInstructionIndex];
    if (!ins) {
      updateDetails();
      return;
    }
    const row = assemblyEl.querySelector('.instruction[data-index="' + ins.index + '"]');
    if (row) row.classList.add("selected");
    const fn = ndbFunctionFor(ins);
    const fnOffset = fn ? fn.codeOffsetStart : ins.codeOffset;
    const fnRow = functionsEl.querySelector('.fn-item[data-code-offset="' + fnOffset + '"]');
    if (fnRow) fnRow.classList.add("active");
    const fnBtn = functionsEl.querySelector('[data-code-offset="' + ins.codeOffset + '"]');
    if (fnBtn) fnBtn.classList.add("active");
    highlightRange(ins.fileOffset, ins.size, false);
    if (selectedPartIndex != null && ins.parts && ins.parts[selectedPartIndex]) {
      const part = ins.parts[selectedPartIndex];
      highlightRange(part.fileOffset, part.length, true);
      const operand = row && row.querySelector('[data-part-index="' + selectedPartIndex + '"]');
      if (operand) operand.classList.add("selected-field");
    }
    updateDetails();
    persist();
  }

  function scrollBytesIntoView() {
    const target = bytecodeEl.querySelector(".selected-field, .in-range");
    if (target && target.scrollIntoView) target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function scrollInstructionIntoView() {
    const row = assemblyEl.querySelector(".instruction.selected") || assemblyEl.querySelector(".instruction.search-hit");
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }

  function detailRow(label, value) {
    return "<dt>" + escapeHtml(label) + "</dt><dd>" + value + "</dd>";
  }

  function updateDetails() {
    if (selectedHeader) {
      const header = inspection.header || {};
      const part = selectedHeaderPartIndex != null ? headerParts[selectedHeaderPartIndex] : undefined;
      let rows = detailRow("Present", escapeHtml(header.present ? "yes" : "no")) +
        detailRow("Size", escapeHtml(String(header.size || 0) + " bytes"));
      if (header.version) rows += detailRow("Version", escapeHtml(header.version));
      if (header.fileSize != null) rows += detailRow("Declared file size", escapeHtml(header.fileSize + " (0x" + padHex(header.fileSize, 8) + ")"));
      if (part) {
        rows += detailRow("Field", escapeHtml(part.text || part.kind));
        rows += detailRow("File offset", escapeHtml("0x" + padHex(part.fileOffset, 8)));
        rows += detailRow("Length", escapeHtml(part.length + " bytes"));
        if (part.value != null) rows += detailRow("Value", escapeHtml(part.value));
      }
      detailsEl.innerHTML = "<h2>NCS Header</h2><dl>" + rows + "</dl>";
      return;
    }
    if (selectedInstructionIndex == null) {
      detailsEl.innerHTML = '<div class="muted">Select an instruction or byte.</div>';
      return;
    }
    const ins = instructions[selectedInstructionIndex];
    let rows = detailRow("Code offset", escapeHtml("0x" + padHex(ins.codeOffset, 8))) +
      detailRow("File offset", escapeHtml("0x" + padHex(ins.fileOffset, 8))) +
      detailRow("Size", escapeHtml(ins.size + " bytes")) +
      detailRow("Opcode", escapeHtml("0x" + padHex(ins.opcode, 2))) +
      detailRow("Aux", escapeHtml("0x" + padHex(ins.aux, 2)));
    const info = ins.actionId != null ? actionInfo(ins.actionId) : undefined;
    if (ins.actionId != null) rows += detailRow("Action ID", escapeHtml("0x" + padHex(ins.actionId, 4)));
    if (info) {
      rows += detailRow("Action", escapeHtml(info.name));
      rows += detailRow("Signature", "<code>" + escapeHtml(info.signature) + "</code>");
      if (info.documentation) rows += detailRow("Docs", escapeHtml(info.documentation));
    } else if (ins.actionName) {
      rows += detailRow("Action", escapeHtml(ins.actionName));
    }
    if (ins.actionId != null && compat[ins.actionId]) {
      rows += detailRow("Compatibility", escapeHtml(compat[ins.actionId].detail));
    }
    if (ins.jumpTarget != null) {
      const addressPart = (ins.parts || []).find(function (part) { return part.kind === "address"; });
      if (addressPart && typeof addressPart.value === "number") {
        const rel = addressPart.value;
        rows += detailRow("Relative offset", escapeHtml((rel < 0 ? "-" : "+") + "0x" + padHex(Math.abs(rel), 8)));
      }
      const label = labels[ins.jumpTarget] || ("0x" + padHex(ins.jumpTarget, 8));
      const canJump = instructionByCodeOffset[ins.jumpTarget];
      rows += detailRow("Target", canJump
        ? '<span class="jump-target" data-jump="' + ins.jumpTarget + '">' + escapeHtml(label) + "</span>"
        : escapeHtml(label));
    }
    const src = ndbLineFor(ins);
    const fn = ndbFunctionFor(ins);
    if (fn) rows += detailRow("NDB function", escapeHtml(fn.label));
    if (src) {
      rows += detailRow("Source", escapeHtml((src.file || "script") + ".nss:" + src.line));
    }
    const parts = displayParts(ins);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const value = part.text != null && part.text !== "" ? part.text : (part.value != null ? part.value : "");
      rows += detailRow(part.kind, escapeHtml(value));
    }
    let extra = "";
    if (src) {
      extra = '<div class="open-source"><button type="button" id="open-source">Open Source at Instruction</button></div>';
    }
    detailsEl.innerHTML = "<h2>" + escapeHtml(ins.mnemonic) + "</h2><dl>" + rows + "</dl>" + extra;
    const openBtn = document.getElementById("open-source");
    if (openBtn && src) {
      openBtn.addEventListener("click", function () {
        vscode.postMessage({ type: "openSource", file: src.file, line: src.line });
      });
    }
    const jumpEl = detailsEl.querySelector("[data-jump]");
    if (jumpEl) {
      jumpEl.addEventListener("click", function () {
        jumpToCodeOffset(Number(jumpEl.getAttribute("data-jump")));
      });
    }
  }

  function selectInstruction(index, partIndex, scrollAsm) {
    selectedHeader = false;
    selectedHeaderPartIndex = undefined;
    selectedInstructionIndex = index;
    selectedPartIndex = partIndex;
    applySelection();
    scrollBytesIntoView();
    if (scrollAsm) scrollInstructionIntoView();
  }

  function selectHeader(partIndex) {
    selectedHeader = true;
    selectedHeaderPartIndex = partIndex;
    selectedInstructionIndex = undefined;
    selectedPartIndex = undefined;
    applySelection();
  }

  function jumpToCodeOffset(offset) {
    const ins = instructionByCodeOffset[offset];
    if (!ins) return false;
    selectInstruction(ins.index, undefined, true);
    return true;
  }

  function parseOffset(query) {
    const raw = query.trim();
    const stripped = raw.replace(/^(0x|off_|fn_)/i, "");
    if (!/^[0-9a-f]+$/i.test(stripped)) return undefined;
    return parseInt(stripped, 16);
  }

  function parseByteSeq(query) {
    const compact = query.replace(/\\s+/g, "");
    if (!/^[0-9a-f]+$/i.test(compact) || compact.length < 2 || compact.length % 2 !== 0) return undefined;
    const values = [];
    for (let i = 0; i < compact.length; i += 2) values.push(parseInt(compact.substr(i, 2), 16));
    return values;
  }

  function unique(list) {
    const seen = {};
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      if (seen[list[i]]) continue;
      seen[list[i]] = true;
      out.push(list[i]);
    }
    return out;
  }

  function collectMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const found = [];
    const offset = parseOffset(q);
    if (offset != null) {
      if (instructionByCodeOffset[offset]) found.push(instructionByCodeOffset[offset].index);
      for (let i = 0; i < instructions.length; i += 1) {
        if (instructions[i].fileOffset === offset) found.push(instructions[i].index);
      }
    }
    for (let i = 0; i < instructions.length; i += 1) {
      const ins = instructions[i];
      if (ins.mnemonic.toLowerCase().indexOf(q) >= 0) found.push(ins.index);
      if (ins.actionName && ins.actionName.toLowerCase().indexOf(q) >= 0) found.push(ins.index);
      const info = ins.actionId != null ? actionInfo(ins.actionId) : undefined;
      if (info && info.name.toLowerCase().indexOf(q) >= 0) found.push(ins.index);
    }
    const seq = parseByteSeq(q);
    if (seq && seq.length) {
      for (let i = 0; i <= bytes.length - seq.length; i += 1) {
        let ok = true;
        for (let s = 0; s < seq.length; s += 1) {
          if (bytes[i + s] !== seq[s]) { ok = false; break; }
        }
        if (ok && byteInfo[i] && byteInfo[i].instructionIndex != null) found.push(byteInfo[i].instructionIndex);
      }
    }
    return unique(found);
  }

  function applySearch(query, cycle) {
    searchQuery = query;
    matches = collectMatches(query);
    if (!matches.length) {
      matchIndex = -1;
      searchMetaEl.textContent = query.trim() ? "0 matches" : "";
      applySelection();
      persist();
      return;
    }
    if (cycle === "prev") matchIndex = (matchIndex - 1 + matches.length) % matches.length;
    else if (cycle === "next" || matchIndex < 0) matchIndex = (matchIndex + 1) % matches.length;
    if (matchIndex < 0 || matchIndex >= matches.length) matchIndex = 0;
    searchMetaEl.textContent = (matchIndex + 1) + " / " + matches.length;
    selectInstruction(matches[matchIndex], undefined, true);
  }

  function selectedAsmLine() {
    if (selectedInstructionIndex == null) return "";
    const ins = instructions[selectedInstructionIndex];
    if (!ins) return "";
    return padHex(ins.codeOffset, 8) + "  " + ins.mnemonic + (ins.operandText ? " " + ins.operandText : "");
  }

  function selectedBytesText() {
    if (selectedInstructionIndex == null) return "";
    const ins = instructions[selectedInstructionIndex];
    if (!ins) return "";
    const start = selectedPartIndex != null && ins.parts && ins.parts[selectedPartIndex]
      ? ins.parts[selectedPartIndex].fileOffset
      : ins.fileOffset;
    const length = selectedPartIndex != null && ins.parts && ins.parts[selectedPartIndex]
      ? ins.parts[selectedPartIndex].length
      : ins.size;
    const parts = [];
    for (let i = 0; i < length; i += 1) parts.push(padHex(bytes[start + i], 2));
    return parts.join(" ");
  }

  function applyPayload(next, restore) {
    payload = next;
    bytes = fromBase64(next.bytes);
    inspection = next.inspection || inspection;
    actions = next.actions || [];
    compat = next.compat || {};
    ndb = next.ndb || null;
    document.getElementById("filename").textContent = next.filename || "";
    document.getElementById("file-meta").textContent = bytes.length.toLocaleString() + " bytes";
    const errorText = next.inspectError || (inspection.error && inspection.error.message) || "";
    if (errorText) {
      errorEl.hidden = false;
      errorEl.textContent = errorText;
    } else {
      errorEl.hidden = true;
      errorEl.textContent = "";
    }
    rebuildDerived();
    renderAssembly();
    renderBytecode();
    renderFunctions();
    if (restore && restore.codeOffset != null && jumpToCodeOffset(restore.codeOffset)) return;
    if (next.revealCodeOffset != null && jumpToCodeOffset(next.revealCodeOffset)) return;
    if (saved.selectedInstructionIndex != null && instructions[saved.selectedInstructionIndex]) {
      selectInstruction(saved.selectedInstructionIndex, saved.selectedPartIndex, true);
      return;
    }
    updateDetails();
  }

  assemblyEl.addEventListener("click", function (event) {
    const operand = event.target.closest("[data-part-index]");
    const instruction = event.target.closest(".instruction");
    if (!instruction) return;
    const index = Number(instruction.getAttribute("data-index"));
    const ins = instructions[index];
    if (operand && ins && ins.parts && ins.parts[Number(operand.getAttribute("data-part-index"))].kind === "address" && ins.jumpTarget != null) {
      if (jumpToCodeOffset(ins.jumpTarget)) return;
    }
    const partIndex = operand ? Number(operand.getAttribute("data-part-index")) : undefined;
    selectInstruction(index, partIndex, false);
  });

  bytecodeEl.addEventListener("click", function (event) {
    const byte = event.target.closest("[data-offset]");
    if (!byte) return;
    const offset = Number(byte.getAttribute("data-offset"));
    const info = byteInfo[offset];
    if (!info) return;
    if (info.header) {
      selectHeader(info.headerPartIndex);
      return;
    }
    selectInstruction(info.instructionIndex, info.partIndex, true);
  });

  functionsEl.addEventListener("click", function (event) {
    const button = event.target.closest("[data-code-offset]");
    if (!button) return;
    jumpToCodeOffset(Number(button.getAttribute("data-code-offset")));
  });

  function setLayout(next) {
    layout = next;
    document.body.classList.remove("layout-split", "layout-assembly", "layout-bytecode");
    document.body.classList.add("layout-" + layout);
    const buttons = document.querySelectorAll(".modes button");
    for (let i = 0; i < buttons.length; i += 1) {
      buttons[i].classList.toggle("active", buttons[i].getAttribute("data-layout") === layout);
    }
    persist();
  }

  const modeButtons = document.querySelectorAll(".modes button");
  for (let i = 0; i < modeButtons.length; i += 1) {
    modeButtons[i].addEventListener("click", function () {
      setLayout(modeButtons[i].getAttribute("data-layout"));
    });
  }

  document.getElementById("toggle-details").addEventListener("click", function () {
    detailsCollapsed = !detailsCollapsed;
    document.body.classList.toggle("details-collapsed", detailsCollapsed);
    persist();
  });

  document.getElementById("toggle-functions").addEventListener("click", function () {
    functionsOpen = !functionsOpen;
    document.body.classList.toggle("functions-open", functionsOpen);
    document.getElementById("toggle-functions").classList.toggle("active", functionsOpen);
    persist();
  });

  function applySplit() {
    document.body.style.setProperty("--split-ratio", Math.round(splitRatio * 100) + "%");
  }

  dividerEl.addEventListener("pointerdown", function (event) {
    event.preventDefault();
    const startX = event.clientX;
    const startRatio = splitRatio;
    const width = workspaceEl.getBoundingClientRect().width;
    function onMove(moveEvent) {
      const delta = (moveEvent.clientX - startX) / width;
      splitRatio = Math.min(0.8, Math.max(0.2, startRatio + delta));
      applySplit();
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persist();
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  searchEl.value = searchQuery;
  searchEl.addEventListener("input", function () {
    applySearch(searchEl.value, "next");
  });
  searchEl.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      applySearch(searchEl.value, event.shiftKey ? "prev" : "next");
    }
    if (event.key === "Escape") {
      searchEl.value = "";
      applySearch("", "next");
      searchEl.blur();
    }
  });

  window.addEventListener("keydown", function (event) {
    const typing = event.target === searchEl || event.target.tagName === "INPUT";
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      searchEl.focus();
      searchEl.select();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && !typing) {
      const text = selectedAsmLine();
      const hex = selectedBytesText();
      if (text) vscode.postMessage({ type: "copy", text: hex ? text + "\\n" + hex : text });
      return;
    }
    if (typing) return;
    if (event.key === "/" ) {
      event.preventDefault();
      searchEl.focus();
      return;
    }
    if (event.key === "Escape") {
      searchEl.value = "";
      applySearch("", "next");
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = selectedInstructionIndex == null ? 0 : Math.min(instructions.length - 1, selectedInstructionIndex + 1);
      if (instructions[next]) selectInstruction(next, undefined, true);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const prev = selectedInstructionIndex == null ? 0 : Math.max(0, selectedInstructionIndex - 1);
      if (instructions[prev]) selectInstruction(prev, undefined, true);
    }
    if (event.key === "Enter" && selectedInstructionIndex != null) {
      const ins = instructions[selectedInstructionIndex];
      if (ins && ins.jumpTarget != null) jumpToCodeOffset(ins.jumpTarget);
    }
  });

  window.addEventListener("message", function (event) {
    const message = event.data;
    if (message.type === "reveal" && message.codeOffset != null) {
      jumpToCodeOffset(Number(message.codeOffset));
      return;
    }
    if (message.type !== "reload") return;
    const previous = selectedInstructionIndex != null && instructions[selectedInstructionIndex]
      ? instructions[selectedInstructionIndex].codeOffset
      : undefined;
    applyPayload(Object.assign({}, payload, message), { codeOffset: previous });
    if (searchQuery) applySearch(searchQuery, "next");
  });

  setLayout(layout);
  applySplit();
  document.body.classList.toggle("details-collapsed", detailsCollapsed);
  document.body.classList.toggle("functions-open", functionsOpen);
  document.getElementById("toggle-functions").classList.toggle("active", functionsOpen);
  applyPayload(payload);
  if (searchQuery) applySearch(searchQuery, "next");
})();
`;
