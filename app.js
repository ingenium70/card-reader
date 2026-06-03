(function () {
  "use strict";

  var els = {
    camera: document.getElementById("cameraInput"),
    gallery: document.getElementById("galleryInput"),
    previewWrap: document.getElementById("previewWrap"),
    preview: document.getElementById("preview"),
    progress: document.getElementById("progress"),
    progressBar: document.getElementById("progressBar"),
    progressLabel: document.getElementById("progressLabel"),
    status: document.getElementById("status"),
    resultCard: document.getElementById("resultCard"),
    rawText: document.getElementById("rawText"),
    save: document.getElementById("saveBtn"),
    net: document.getElementById("netState"),
    f: {
      name: document.getElementById("f_name"),
      org: document.getElementById("f_org"),
      title: document.getElementById("f_title"),
      mobile: document.getElementById("f_mobile"),
      phone: document.getElementById("f_phone"),
      email: document.getElementById("f_email"),
      url: document.getElementById("f_url"),
      addr: document.getElementById("f_addr"),
    },
  };

  // ---------- UI helpers ----------
  function setStatus(msg, isError) {
    els.status.textContent = msg || "";
    els.status.classList.toggle("error", !!isError);
  }

  function showProgress(show) {
    els.progress.hidden = !show;
    if (!show) {
      els.progressBar.style.width = "0%";
    }
  }

  function setProgress(ratio, label) {
    els.progressBar.style.width = Math.round(ratio * 100) + "%";
    if (label) els.progressLabel.textContent = label;
  }

  // ---------- image -> preprocessed dataURL ----------
  function fileToProcessedImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        try {
          var maxW = 1600;
          var scale = Math.min(1, maxW / img.naturalWidth);
          var w = Math.round(img.naturalWidth * scale);
          var h = Math.round(img.naturalHeight * scale);

          var canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);

          // grayscale + light contrast boost for better OCR
          var imgData = ctx.getImageData(0, 0, w, h);
          var d = imgData.data;
          for (var i = 0; i < d.length; i += 4) {
            var gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
            var v = (gray - 128) * 1.15 + 128;
            v = v < 0 ? 0 : v > 255 ? 255 : v;
            d[i] = d[i + 1] = d[i + 2] = v;
          }
          ctx.putImageData(imgData, 0, 0);

          resolve({
            dataUrl: canvas.toDataURL("image/jpeg", 0.9),
            previewUrl: canvas.toDataURL("image/jpeg", 0.7),
          });
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("이미지를 불러오지 못했습니다."));
      };
      img.src = url;
    });
  }

  // ---------- OCR ----------
  function runOcr(dataUrl) {
    if (typeof Tesseract === "undefined") {
      return Promise.reject(
        new Error("OCR 엔진을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.")
      );
    }
    return Tesseract.recognize(dataUrl, "kor+eng", {
      logger: function (m) {
        if (m.status === "recognizing text") {
          setProgress(m.progress, "글자 인식 중… " + Math.round(m.progress * 100) + "%");
        } else if (m.status === "loading language traineddata" || m.status === "loading tesseract core") {
          setProgress(m.progress * 0.3, "엔진 준비 중…");
        }
      },
    }).then(function (res) {
      return res.data.text || "";
    });
  }

  // ---------- parsing ----------
  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var URL_RE = /\b((?:https?:\/\/)?(?:www\.)?[A-Za-z0-9-]+\.(?:com|net|org|co\.kr|kr|io|dev|me|info|biz)(?:\/[^\s]*)?)\b/i;
  var MOBILE_RE = /(?:\+?82[-.\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/;
  var PHONE_RE = /(?:\+?82[-.\s]?)?0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g;

  var TITLE_KEYWORDS = [
    "대표", "이사", "부장", "차장", "과장", "대리", "팀장", "실장", "사원",
    "부사장", "사장", "회장", "전무", "상무", "본부장", "매니저", "주임", "연구원",
    "CEO", "CTO", "CFO", "COO", "Manager", "Director", "Engineer", "Designer",
    "President", "Lead", "Head", "Founder", "Developer",
  ];
  var ORG_KEYWORDS = [
    "주식회사", "㈜", "(주)", "유한회사", "Inc", "Inc.", "Corp", "Corp.",
    "Co.", "Ltd", "Ltd.", "Company", "Group", "그룹", "컴퍼니", "스튜디오", "Lab",
  ];

  function cleanPhone(s) {
    return s.replace(/[^\d+]/g, "").replace(/^82/, "+82").replace(/^\+?820/, "+82");
  }

  function parseCard(text) {
    var out = { name: "", org: "", title: "", mobile: "", phone: "", email: "", url: "", addr: "" };
    var rawLines = text.split(/\r?\n/).map(function (l) { return l.trim(); });
    var lines = rawLines.filter(function (l) { return l.length > 0; });

    // email
    for (var i = 0; i < lines.length; i++) {
      var em = lines[i].match(EMAIL_RE);
      if (em) { out.email = em[0]; break; }
    }

    // url (skip lines that are emails)
    for (var j = 0; j < lines.length; j++) {
      if (EMAIL_RE.test(lines[j])) continue;
      var um = lines[j].match(URL_RE);
      if (um) { out.url = um[1]; break; }
    }

    // phones
    var phones = [];
    var allText = lines.join("\n");
    var pm;
    PHONE_RE.lastIndex = 0;
    while ((pm = PHONE_RE.exec(allText)) !== null) {
      phones.push(pm[0]);
    }
    phones.forEach(function (p) {
      var digits = p.replace(/[^\d]/g, "");
      var isMobile = /^(?:82)?01[016789]/.test(digits) || MOBILE_RE.test(p);
      if (isMobile && !out.mobile) out.mobile = cleanPhone(p);
      else if (!isMobile && !out.phone) out.phone = cleanPhone(p);
    });
    if (!out.mobile && !out.phone && phones.length) out.phone = cleanPhone(phones[0]);

    // title & org via keywords
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k];
      if (!out.title) {
        for (var t = 0; t < TITLE_KEYWORDS.length; t++) {
          if (line.indexOf(TITLE_KEYWORDS[t]) !== -1) { out.title = line; break; }
        }
      }
      if (!out.org) {
        for (var o = 0; o < ORG_KEYWORDS.length; o++) {
          if (line.indexOf(ORG_KEYWORDS[o]) !== -1) { out.org = line; break; }
        }
      }
    }

    // address heuristic: line containing a region keyword
    var ADDR_RE = /(시|도|구|군|읍|면|동|로|길|번지|층|호)\b|서울|부산|대구|인천|광주|대전|울산|경기|강원|충청|전라|경상|제주/;
    for (var a = 0; a < lines.length; a++) {
      if (EMAIL_RE.test(lines[a])) continue;
      if (lines[a].replace(/[^\d]/g, "").length >= 8) continue; // skip phone-heavy
      if (ADDR_RE.test(lines[a]) && lines[a].length >= 8) { out.addr = lines[a]; break; }
    }

    // name: prefer a short line that's not email/url/phone/title/org/addr
    var used = [out.title, out.org, out.addr];
    for (var n = 0; n < lines.length; n++) {
      var L = lines[n];
      if (used.indexOf(L) !== -1) continue;
      if (EMAIL_RE.test(L) || URL_RE.test(L)) continue;
      if (/\d{3,}/.test(L)) continue;
      var letters = L.replace(/[^A-Za-z가-힣\s]/g, "").trim();
      if (letters.length >= 2 && letters.length <= 20) { out.name = letters; break; }
    }

    return out;
  }

  function fillForm(data) {
    els.f.name.value = data.name || "";
    els.f.org.value = data.org || "";
    els.f.title.value = data.title || "";
    els.f.mobile.value = data.mobile || "";
    els.f.phone.value = data.phone || "";
    els.f.email.value = data.email || "";
    els.f.url.value = data.url || "";
    els.f.addr.value = data.addr || "";
  }

  // ---------- vCard ----------
  function esc(s) {
    return String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  }

  function buildVCard() {
    var f = els.f;
    var name = f.name.value.trim();
    var lines = ["BEGIN:VCARD", "VERSION:3.0"];
    lines.push("N:" + esc(name) + ";;;;");
    lines.push("FN:" + esc(name || "이름 없음"));
    if (f.org.value.trim()) lines.push("ORG:" + esc(f.org.value.trim()));
    if (f.title.value.trim()) lines.push("TITLE:" + esc(f.title.value.trim()));
    if (f.mobile.value.trim()) lines.push("TEL;TYPE=CELL:" + esc(f.mobile.value.trim()));
    if (f.phone.value.trim()) lines.push("TEL;TYPE=WORK,VOICE:" + esc(f.phone.value.trim()));
    if (f.email.value.trim()) lines.push("EMAIL;TYPE=INTERNET:" + esc(f.email.value.trim()));
    if (f.url.value.trim()) lines.push("URL:" + esc(f.url.value.trim()));
    if (f.addr.value.trim()) lines.push("ADR;TYPE=WORK:;;" + esc(f.addr.value.trim()) + ";;;;");
    lines.push("END:VCARD");
    return lines.join("\r\n");
  }

  function saveContact() {
    var name = els.f.name.value.trim() || "contact";
    var vcard = buildVCard();
    var blob = new Blob([vcard], { type: "text/vcard;charset=utf-8" });
    var filename = name.replace(/[^\w가-힣-]/g, "_") + ".vcf";
    var file = new File([blob], filename, { type: "text/vcard" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator
        .share({ files: [file], title: name })
        .catch(function () { downloadBlob(blob, filename); });
    } else {
      downloadBlob(blob, filename);
    }
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus("연락처 파일(.vcf)이 생성되었습니다. 파일을 열어 연락처에 추가하세요.");
  }

  // ---------- flow ----------
  function handleFile(file) {
    if (!file) return;
    setStatus("");
    els.resultCard.hidden = true;
    showProgress(true);
    setProgress(0, "이미지 준비 중…");

    fileToProcessedImage(file)
      .then(function (res) {
        els.preview.src = res.previewUrl;
        els.previewWrap.hidden = false;
        return runOcr(res.dataUrl);
      })
      .then(function (text) {
        showProgress(false);
        els.rawText.textContent = text;
        var data = parseCard(text);
        fillForm(data);
        els.resultCard.hidden = false;
        if (!text.trim()) {
          setStatus("글자를 찾지 못했어요. 밝은 곳에서 명함을 가득 채워 다시 촬영해 보세요.", true);
        } else {
          setStatus("인식 완료! 내용을 확인하고 저장하세요.");
          els.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      })
      .catch(function (err) {
        showProgress(false);
        setStatus(err.message || "처리 중 오류가 발생했습니다.", true);
      });
  }

  els.camera.addEventListener("change", function (e) {
    handleFile(e.target.files && e.target.files[0]);
    e.target.value = "";
  });
  els.gallery.addEventListener("change", function (e) {
    handleFile(e.target.files && e.target.files[0]);
    e.target.value = "";
  });
  els.save.addEventListener("click", saveContact);

  // ---------- network state + service worker ----------
  function updateNet() {
    els.net.textContent = navigator.onLine ? "" : "오프라인 — 인식 기능은 인터넷 연결이 필요합니다.";
  }
  window.addEventListener("online", updateNet);
  window.addEventListener("offline", updateNet);
  updateNet();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }
})();
