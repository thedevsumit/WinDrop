import React, { useEffect, useState, useRef, useCallback } from "react";
import io from "socket.io-client";
import axios from "axios";

const API_BASE = `http://${window.location.hostname}:5000`;
const socket = io(API_BASE);

function App() {
  const [peers, setPeers] = useState([]);
  const [manualPeers, setManualPeers] = useState([]);
  const [manualIp, setManualIp] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [isSearching, setIsSearching] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [dragCounter, setDragCounter] = useState(0);
  const [activeTransfers, setActiveTransfers] = useState({});
  const [transferRequest, setTransferRequest] = useState(null);
  const [transferError, setTransferError] = useState(null);
  const [history, setHistory] = useState([]);
  const [backendConnected, setBackendConnected] = useState(false);

  // Receiving is modeled as an explicit state machine instead of one loosely
  // shaped object, specifically because the backend's "transfer-progress"
  // event carries two different payload shapes: an in-progress update
  // ({ id, currentChunk, totalChunks }) and a completion signal
  // ({ id, status: 'completed' }) with no chunk counts at all. Treating both
  // the same way is exactly what caused the "NaN%" bug -- computing
  // currentChunk / totalChunks when those fields don't exist. Splitting
  // "receiving" and "done" into distinct states makes that mismatch
  // impossible to reintroduce by accident.
  const [receiving, setReceiving] = useState(null); // { phase: 'active'|'done', currentChunk, totalChunks, filename }
  const fileInputRef = useRef(null);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/transfers`);
      setHistory(res.data);
    } catch (err) {
      console.error("Failed to fetch history", err);
    }
  }, []);

  useEffect(() => {
    fetchHistory();

    socket.on("connect", () => setBackendConnected(true));
    socket.on("disconnect", () => setBackendConnected(false));
    socket.on("connect_error", (err) => {
      console.error("Backend connection error:", err.message, "— tried:", socket.io.uri);
      setBackendConnected(false);
    });

    socket.on("peers_list", (peerList) => {
      setPeers(peerList);
      setIsSearching(false);
    });

    socket.on("incoming-transfer-request", (data) => {
      setTransferRequest(data);
      // A fresh request means any previous receiving state is stale.
      setReceiving(null);
    });

    socket.on("transfer-progress", (data) => {
      if (data.status === "completed") {
        // Terminal event -- no chunk counts included by design. Show a
        // clean "done" state instead of feeding this into percentage math.
        setReceiving((prev) => ({
          phase: "done",
          filename: prev?.filename,
        }));
        fetchHistory(); // this is the fix for "only shows success after a refresh"
        setTimeout(() => setReceiving(null), 4000);
        return;
      }

      setReceiving((prev) => ({
        phase: "active",
        currentChunk: data.currentChunk,
        totalChunks: data.totalChunks,
        filename: prev?.filename,
      }));
    });

    socket.on("transfer-error", (data) => {
      setTransferError(data);
      setReceiving(null);
      fetchHistory();
      setTimeout(() => setTransferError(null), 6000);
    });

    socket.on("sending-progress", (data) => {
      setActiveTransfers((prev) => ({
        ...prev,
        [data.transferId]: {
          filename: data.filename,
          progress: data.progress,
          status: data.status,
        },
      }));
      if (data.status === "completed" || data.status === "failed") {
        fetchHistory();
      }
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("peers_list");
      socket.off("incoming-transfer-request");
      socket.off("transfer-progress");
      socket.off("transfer-error");
      socket.off("sending-progress");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchHistory]);

  const handleAddManualPeer = () => {
    const ip = manualIp.trim();
    if (!ip) return;
    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipPattern.test(ip)) {
      alert("Enter a valid IPv4 address, e.g. 192.168.1.42");
      return;
    }
    setManualPeers((prev) => {
      if (prev.some((p) => p.ip === ip) || peers.some((p) => p.ip === ip)) return prev;
      return [...prev, { name: `Manual (${ip})`, ip, manual: true }];
    });
    setManualIp("");
  };

  const handleDecision = async (decision) => {
    if (!transferRequest) return;
    const req = transferRequest;
    setTransferRequest(null);
    if (decision === "accept") {
      // Immediate feedback the moment Accept is clicked, rather than a
      // silent gap until the first progress event arrives -- for small
      // files that can transfer in well under 150ms, the "active" phase
      // might never actually render otherwise, and the UI would appear to
      // do nothing between clicking Accept and the final "done" state.
      setReceiving({ phase: "active", currentChunk: 0, totalChunks: 1, filename: req.filename });
    }
    try {
      await axios.post(`${API_BASE}/transfer/decision`, { id: req.id, decision });
    } catch (err) {
      console.error("Decision failed", err);
      setReceiving(null);
    }
  };

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragCounter((prev) => prev + 1);
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragCounter((prev) => {
      const next = prev - 1;
      if (next === 0) setIsDragging(false);
      return next;
    });
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    setDragCounter(0);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) setSelectedFile(files[0]);
  }, []);

  const handleSend = async (targetIp) => {
    if (!selectedFile) return;
    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("targetIp", targetIp);

    try {
      const res = await axios.post(`${API_BASE}/send`, formData);
      if (res.data.transferId) {
        setActiveTransfers((prev) => ({
          ...prev,
          [res.data.transferId]: { filename: selectedFile.name, progress: 0, status: "sending" },
        }));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const openFileDialog = () => fileInputRef.current?.click();
  const totalDevices = peers.length + manualPeers.length;
  const receivingPercent =
    receiving?.phase === "active" && receiving.totalChunks
      ? Math.min(100, Math.round((receiving.currentChunk / receiving.totalChunks) * 100))
      : 0;

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <header style={styles.header}>
          <div style={styles.logo}>
            <span style={styles.logoGlyph}>⚡</span>
          </div>
          <h1 style={styles.title}>WinDrop</h1>
          <p style={styles.subtitle}>Direct, encrypted file transfer on your network</p>
        </header>

        <div style={styles.connectionRow}>
          <span style={{ ...styles.dot, background: backendConnected ? "#34d399" : "#fb7185" }} />
          <span style={{ color: backendConnected ? "#a7f3d0" : "#fda4af" }}>
            {backendConnected ? "Connected to backend" : "Not connected — check the backend is running"}
          </span>
        </div>

        <div
          style={{
            ...styles.dropZone,
            ...(isDragging ? styles.dropZoneActive : {}),
            ...(selectedFile ? styles.dropZoneSelected : {}),
          }}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={openFileDialog}
        >
          <input
            ref={fileInputRef}
            type="file"
            onChange={(e) => e.target.files[0] && setSelectedFile(e.target.files[0])}
            style={{ display: "none" }}
          />
          <div
            style={{
              ...styles.dropIcon,
              ...(isDragging ? styles.dropIconActive : {}),
              ...(selectedFile ? styles.dropIconSelected : {}),
            }}
          >
            {isDragging ? "↓" : selectedFile ? "✓" : "+"}
          </div>
          {isDragging ? (
            <span style={styles.dropHint}>Drop to select</span>
          ) : selectedFile ? (
            <div style={styles.fileInfo}>
              <span style={styles.fileName}>{selectedFile.name}</span>
              <span style={styles.fileSize}>{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</span>
            </div>
          ) : (
            <span style={styles.dropHint}>Drop a file here, or click to browse</span>
          )}
        </div>

        {receiving && (
          <div style={styles.progressCard}>
            <div style={styles.progressHeaderRow}>
              <div style={styles.progressHeaderLeft}>
                {receiving.phase === "active" ? <Spinner /> : <AnimatedCheck />}
                <span style={styles.progressTitle}>
                  {receiving.phase === "active" ? "Receiving file…" : "Received successfully"}
                </span>
              </div>
              {receiving.phase === "active" && (
                <span style={styles.progressPercent}>{receivingPercent}%</span>
              )}
            </div>
            {receiving.filename && <div style={styles.progressFilename}>{receiving.filename}</div>}
            {receiving.phase === "active" && (
              <div style={styles.progressBarBg}>
                <div style={{ ...styles.progressBarFill, width: `${receivingPercent}%` }} />
              </div>
            )}
          </div>
        )}

        {Object.entries(activeTransfers).length > 0 && (
          <div style={styles.progressCard}>
            <div style={styles.progressTitle}>Sending</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginTop: "10px" }}>
              {Object.entries(activeTransfers).map(([id, t]) => (
                <div key={id}>
                  <div style={styles.progressHeaderRow}>
                    <div style={styles.progressHeaderLeft}>
                      {t.status === "completed" ? (
                        <AnimatedCheck />
                      ) : t.status === "failed" ? (
                        <FailedX />
                      ) : (
                        <Spinner />
                      )}
                      <span style={styles.sendingFilename}>{t.filename}</span>
                    </div>
                    <span style={styles.progressPercent}>
                      {t.status === "completed" ? "100%" : t.status === "failed" ? "Failed" : `${t.progress}%`}
                    </span>
                  </div>
                  <div style={styles.progressBarBg}>
                    <div
                      style={{
                        ...styles.progressBarFill,
                        background:
                          t.status === "completed"
                            ? "linear-gradient(90deg, #34d399, #10b981)"
                            : t.status === "failed"
                            ? "#fb7185"
                            : "linear-gradient(90deg, #818cf8, #6366f1)",
                        width: t.status === "completed" ? "100%" : t.status === "failed" ? "100%" : `${t.progress}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={styles.statusBar}>
          {isSearching ? (
            <div style={styles.searching}>
              <span style={styles.searchRing} />
              <span>Scanning network…</span>
            </div>
          ) : totalDevices > 0 ? (
            <div style={styles.deviceCount}>
              <span style={styles.countBadge}>{totalDevices}</span>
              <span>device{totalDevices !== 1 ? "s" : ""} online</span>
            </div>
          ) : (
            <span style={styles.noDevices}>No devices found on the network</span>
          )}
        </div>

        <div style={styles.manualRow}>
          <input
            type="text"
            value={manualIp}
            onChange={(e) => setManualIp(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddManualPeer()}
            placeholder="Add a device by IP (e.g. 192.168.1.42)"
            style={styles.manualInput}
          />
          <button onClick={handleAddManualPeer} style={styles.manualButton}>
            Add
          </button>
        </div>

        <div style={styles.devicesList}>
          {[...peers, ...manualPeers].map((peer) => (
            <div key={peer.ip} style={styles.deviceCard}>
              <div style={styles.deviceLeft}>
                <div style={styles.deviceIcon}>{peer.manual ? "🖥️" : "📱"}</div>
                <div>
                  <div style={styles.deviceName}>{peer.name}</div>
                  <div style={styles.deviceIp}>{peer.ip}</div>
                </div>
              </div>
              <button
                style={{ ...styles.sendButton, ...(!selectedFile ? styles.sendButtonDisabled : {}) }}
                onClick={() => handleSend(peer.ip)}
                disabled={!selectedFile}
              >
                Send
              </button>
            </div>
          ))}
        </div>

        {history.length > 0 && (
          <div style={styles.historySection}>
            <h3 style={styles.historyTitle}>Recent Transfers</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {history.slice(0, 6).map((item) => (
                <div key={item.id} style={styles.historyItem}>
                  <div style={styles.historyIcon}>{item.direction === "received" ? "⬇️" : "⬆️"}</div>
                  <div style={styles.historyFileInfo}>
                    <span style={styles.historyFileName}>{item.filename}</span>
                    <span style={styles.historyFileMeta}>
                      {item.direction === "received" ? `From ${item.sender ?? "peer"}` : `To ${item.targetIp}`}
                      {" • "}
                      {(item.size / 1024 / 1024).toFixed(2)} MB
                    </span>
                  </div>
                  <span
                    style={{
                      ...styles.historyStatus,
                      ...(item.status === "success"
                        ? styles.statusSuccess
                        : item.status === "failed"
                        ? styles.statusFailed
                        : styles.statusPending),
                    }}
                  >
                    {item.status.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {transferRequest && (
        <div style={styles.modalOverlay}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <div style={styles.modalIcon}>📦</div>
              <h2 style={styles.modalTitle}>Incoming File</h2>
            </div>
            <div style={styles.modalBody}>
              <div style={styles.modalRow}>
                <span style={styles.modalLabel}>Sender</span>
                <span style={styles.modalValue}>{transferRequest.sender}</span>
              </div>
              <div style={styles.modalRow}>
                <span style={styles.modalLabel}>File</span>
                <span style={styles.modalValue}>{transferRequest.filename}</span>
              </div>
              <div style={styles.modalRow}>
                <span style={styles.modalLabel}>Size</span>
                <span style={styles.modalValue}>{(transferRequest.size / 1024 / 1024).toFixed(2)} MB</span>
              </div>
            </div>
            <div style={styles.modalFooter}>
              <button style={styles.rejectButton} onClick={() => handleDecision("reject")}>
                Reject
              </button>
              <button style={styles.acceptButton} onClick={() => handleDecision("accept")}>
                Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {transferError && (
        <div style={styles.errorToast}>
          <span style={{ fontSize: "18px" }}>⚠️</span>
          <div>
            <div style={styles.errorCode}>{transferError.code}</div>
            <div style={styles.errorMessage}>{transferError.message}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" style={{ animation: "windropSpin 0.8s linear infinite", flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" stroke="#818cf8" strokeWidth="2.5" fill="none" opacity="0.25" />
      <path d="M12 2 A10 10 0 0 1 22 12" stroke="#818cf8" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function AnimatedCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <circle className="windrop-circle" cx="12" cy="12" r="10" fill="#10b981" />
      <path
        className="windrop-path"
        d="M7 12.5l3.5 3.5 6.5-7"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        strokeDasharray="30"
      />
    </svg>
  );
}

function FailedX() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" fill="#fb7185" style={{ animation: "windropFail 0.2s ease" }} />
      <path d="M8 8l8 8M16 8l-8 8" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "radial-gradient(circle at 20% 0%, #1e1b3a 0%, #0f0d1e 55%, #0a0914 100%)",
    padding: "56px 20px",
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    display: "flex",
    justifyContent: "center",
  },
  card: {
    width: "100%",
    maxWidth: "440px",
    background: "rgba(255, 255, 255, 0.04)",
    backdropFilter: "blur(20px)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    borderRadius: "28px",
    padding: "36px 28px",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.4)",
    height: "fit-content",
  },
  header: { textAlign: "center", marginBottom: "24px" },
  logo: {
    width: "64px",
    height: "64px",
    margin: "0 auto 16px",
    background: "linear-gradient(135deg, #818cf8 0%, #6366f1 60%, #4f46e5 100%)",
    borderRadius: "20px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 10px 30px rgba(99, 102, 241, 0.4)",
  },
  logoGlyph: { fontSize: "30px" },
  title: {
    fontSize: "26px",
    fontWeight: 700,
    color: "#f8fafc",
    margin: "0 0 6px 0",
    letterSpacing: "-0.5px",
  },
  subtitle: { fontSize: "14px", color: "#94a3b8", margin: 0 },
  connectionRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "12px",
    marginBottom: "18px",
    padding: "8px 12px",
    background: "rgba(255,255,255,0.03)",
    borderRadius: "10px",
  },
  dot: { width: "7px", height: "7px", borderRadius: "50%", flexShrink: 0 },
  dropZone: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    padding: "28px 20px",
    background: "rgba(255,255,255,0.02)",
    borderRadius: "18px",
    border: "1.5px dashed rgba(255,255,255,0.15)",
    cursor: "pointer",
    transition: "all 0.2s ease",
    marginBottom: "18px",
  },
  dropZoneActive: {
    borderColor: "#818cf8",
    background: "rgba(99, 102, 241, 0.08)",
    transform: "scale(1.01)",
  },
  dropZoneSelected: {
    borderColor: "rgba(16, 185, 129, 0.4)",
    borderStyle: "solid",
  },
  dropIcon: {
    width: "44px",
    height: "44px",
    borderRadius: "14px",
    background: "rgba(99, 102, 241, 0.12)",
    border: "1.5px solid rgba(129, 140, 248, 0.3)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "22px",
    color: "#a5b4fc",
    fontWeight: 600,
    transition: "all 0.2s ease",
  },
  dropIconActive: { transform: "scale(1.1)", borderColor: "#818cf8" },
  dropIconSelected: {
    color: "#34d399",
    borderColor: "rgba(52, 211, 153, 0.4)",
    background: "rgba(16, 185, 129, 0.1)",
  },
  dropHint: { fontSize: "13px", color: "#94a3b8", textAlign: "center" },
  fileInfo: { display: "flex", flexDirection: "column", alignItems: "center", gap: "2px" },
  fileName: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#f1f5f9",
    maxWidth: "260px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileSize: { fontSize: "12px", color: "#94a3b8" },
  progressCard: {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: "16px",
    padding: "16px",
    marginBottom: "16px",
  },
  progressHeaderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  progressHeaderLeft: { display: "flex", alignItems: "center", gap: "8px" },
  progressTitle: { fontSize: "13px", fontWeight: 600, color: "#e2e8f0" },
  sendingFilename: {
    fontSize: "12px",
    color: "#cbd5e1",
    maxWidth: "200px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  progressFilename: { fontSize: "12px", color: "#94a3b8", marginTop: "4px" },
  progressPercent: { fontSize: "12px", fontWeight: 700, color: "#a5b4fc" },
  progressBarBg: {
    height: "6px",
    background: "rgba(255,255,255,0.06)",
    borderRadius: "3px",
    overflow: "hidden",
    marginTop: "10px",
  },
  progressBarFill: {
    height: "100%",
    background: "linear-gradient(90deg, #818cf8, #6366f1)",
    transition: "width 0.3s ease",
    borderRadius: "3px",
  },
  statusBar: {
    minHeight: "28px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: "16px",
  },
  searching: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    color: "#a5b4fc",
    fontSize: "13px",
    fontWeight: 500,
  },
  searchRing: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#818cf8",
    animation: "searchPulse 1.2s ease-in-out infinite",
    display: "inline-block",
  },
  deviceCount: { display: "flex", alignItems: "center", gap: "8px", color: "#94a3b8", fontSize: "13px" },
  countBadge: {
    background: "rgba(99, 102, 241, 0.15)",
    color: "#a5b4fc",
    fontWeight: 700,
    padding: "2px 10px",
    borderRadius: "20px",
    fontSize: "12px",
  },
  noDevices: { color: "#64748b", fontSize: "13px" },
  manualRow: { display: "flex", gap: "8px", marginBottom: "14px" },
  manualInput: {
    flex: 1,
    padding: "10px 12px",
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.03)",
    color: "#e2e8f0",
    fontSize: "13px",
    outline: "none",
  },
  manualButton: {
    padding: "10px 16px",
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.06)",
    color: "#e2e8f0",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
  },
  devicesList: { display: "flex", flexDirection: "column", gap: "8px" },
  deviceCard: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 16px",
    background: "rgba(255,255,255,0.02)",
    borderRadius: "14px",
    border: "1px solid rgba(255,255,255,0.06)",
    transition: "all 0.2s ease",
  },
  deviceLeft: { display: "flex", alignItems: "center", gap: "12px" },
  deviceIcon: {
    width: "38px",
    height: "38px",
    borderRadius: "11px",
    background: "rgba(255,255,255,0.04)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "18px",
  },
  deviceName: { fontSize: "14px", fontWeight: 600, color: "#f1f5f9" },
  deviceIp: { fontSize: "11px", color: "#64748b", fontFamily: "'SF Mono', 'Fira Code', monospace" },
  sendButton: {
    padding: "9px 18px",
    borderRadius: "10px",
    border: "none",
    background: "linear-gradient(135deg, #818cf8, #6366f1)",
    color: "#fff",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(99, 102, 241, 0.35)",
    transition: "all 0.15s ease",
  },
  sendButtonDisabled: { opacity: 0.35, cursor: "not-allowed", boxShadow: "none" },
  historySection: {
    marginTop: "24px",
    paddingTop: "20px",
    borderTop: "1px solid rgba(255,255,255,0.06)",
  },
  historyTitle: { fontSize: "13px", fontWeight: 700, color: "#cbd5e1", marginBottom: "12px" },
  historyItem: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 0",
  },
  historyIcon: { fontSize: "14px", width: "20px", textAlign: "center", flexShrink: 0 },
  historyFileInfo: { display: "flex", flexDirection: "column", gap: "2px", flex: 1, minWidth: 0 },
  historyFileName: {
    fontSize: "13px",
    fontWeight: 500,
    color: "#e2e8f0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  historyFileMeta: { fontSize: "11px", color: "#64748b" },
  historyStatus: {
    fontSize: "10px",
    fontWeight: 700,
    padding: "3px 8px",
    borderRadius: "6px",
    flexShrink: 0,
  },
  statusSuccess: { background: "rgba(16, 185, 129, 0.12)", color: "#34d399" },
  statusFailed: { background: "rgba(251, 113, 133, 0.12)", color: "#fb7185" },
  statusPending: { background: "rgba(251, 191, 36, 0.12)", color: "#fbbf24" },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(5, 5, 15, 0.6)",
    backdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: "20px",
  },
  modal: {
    background: "#181528",
    border: "1px solid rgba(255,255,255,0.08)",
    width: "100%",
    maxWidth: "340px",
    borderRadius: "22px",
    padding: "24px",
    boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
    animation: "modalPop 0.25s ease-out",
  },
  modalHeader: { display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" },
  modalIcon: {
    width: "40px",
    height: "40px",
    background: "rgba(99, 102, 241, 0.15)",
    borderRadius: "12px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "20px",
    flexShrink: 0,
  },
  modalTitle: { fontSize: "18px", fontWeight: 700, margin: 0, color: "#f8fafc" },
  modalBody: { display: "flex", flexDirection: "column", gap: "10px", marginBottom: "22px" },
  modalRow: { display: "flex", justifyContent: "space-between", fontSize: "13px" },
  modalLabel: { color: "#94a3b8" },
  modalValue: { fontWeight: 600, color: "#f1f5f9", textAlign: "right", marginLeft: "12px" },
  modalFooter: { display: "flex", gap: "10px" },
  rejectButton: {
    flex: 1,
    padding: "12px",
    borderRadius: "12px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "transparent",
    color: "#cbd5e1",
    fontWeight: 600,
    fontSize: "14px",
    cursor: "pointer",
  },
  acceptButton: {
    flex: 1,
    padding: "12px",
    borderRadius: "12px",
    border: "none",
    background: "linear-gradient(135deg, #818cf8, #6366f1)",
    color: "#fff",
    fontWeight: 600,
    fontSize: "14px",
    cursor: "pointer",
    boxShadow: "0 6px 20px rgba(99, 102, 241, 0.4)",
  },
  errorToast: {
    position: "fixed",
    top: "20px",
    right: "20px",
    left: "20px",
    maxWidth: "360px",
    marginLeft: "auto",
    background: "#2a1520",
    border: "1px solid rgba(251, 113, 133, 0.3)",
    color: "#fda4af",
    padding: "14px 16px",
    borderRadius: "14px",
    boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
    display: "flex",
    gap: "10px",
    alignItems: "flex-start",
    zIndex: 2000,
    animation: "slideIn 0.3s ease-out",
  },
  errorCode: { fontWeight: 700, fontSize: "13px", color: "#fecdd3" },
  errorMessage: { fontSize: "12px", marginTop: "2px", color: "#fda4af" },
};

const globalStyles = `
  @keyframes searchPulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.6); opacity: 0.4; } }
  @keyframes modalPop { from { transform: scale(0.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
  @keyframes slideIn { from { transform: translateX(30px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
  @keyframes windropSpin { to { transform: rotate(360deg); } }
  @keyframes windropFail { from { opacity: 0; transform: scale(0.5); } to { opacity: 1; transform: scale(1); } }
  .windrop-circle { animation: windropPop 0.25s ease forwards; transform-origin: center; }
  .windrop-path { animation: windropCheck 0.3s ease forwards 0.08s; stroke-dashoffset: 30; }
  @keyframes windropPop { 0% { transform: scale(0); } 60% { transform: scale(1.25); } 100% { transform: scale(1); } }
  @keyframes windropCheck { 0% { stroke-dashoffset: 30; opacity: 0; } 20% { opacity: 1; } 100% { stroke-dashoffset: 0; } }
  body { margin: 0; background: #0a0914; }
  * { box-sizing: border-box; }
  input::placeholder { color: #64748b; }
  input:focus { border-color: rgba(129, 140, 248, 0.5) !important; }
`;

if (!document.getElementById("windrop-styles")) {
  const styleSheet = document.createElement("style");
  styleSheet.id = "windrop-styles";
  styleSheet.textContent = globalStyles;
  document.head.appendChild(styleSheet);
}

export default App;