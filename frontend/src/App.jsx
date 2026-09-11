import React, { useEffect, useState, useRef, useCallback } from "react";
import io from "socket.io-client";
import axios from "axios";

const socket = io(`http://${window.location.hostname}:5000`);

function App() {
  const [peers, setPeers] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [isSearching, setIsSearching] = useState(true);
  const [sendingTo, setSendingTo] = useState(null);
  const [sendStatus, setSendStatus] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragCounter, setDragCounter] = useState(0);
  const [transferRequest, setTransferRequest] = useState(null);
  const [receivingProgress, setReceivingProgress] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    socket.on("peers_list", (peerList) => {
      setPeers(peerList);
      setIsSearching(false);
    });

    socket.on("incoming-transfer-request", (data) => {
      setTransferRequest(data);
    });

    socket.on("transfer-progress", (data) => {
      setReceivingProgress(data);
    });

    return () => {
      socket.off("peers_list");
      socket.off("incoming-transfer-request");
      socket.off("transfer-progress");
    };
  }, []);

  const handleDecision = async (decision) => {
    if (!transferRequest) return;
    try {
      await axios.post(`http://${window.location.hostname}:5000/transfer/decision`, {
        id: transferRequest.id,
        decision: decision,
      });
    } catch (err) {
      console.error("Decision failed", err);
    }
    setTransferRequest(null);
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
      const newCount = prev - 1;
      if (newCount === 0) {
        setIsDragging(false);
      }
      return newCount;
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
    if (files && files.length > 0) {
      setSelectedFile(files[0]);
    }
  }, []);

  const handleSend = async (targetIp) => {
    if (!selectedFile) return;
    setSendingTo(targetIp);
    setSendStatus(null);

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("targetIp", targetIp);

    try {
      await axios.post(`http://${window.location.hostname}:5000/send`, formData);
      setSendStatus({ success: true, ip: targetIp });
    } catch (err) {
      console.error(err);
      setSendStatus({ success: false, ip: targetIp });
    }
    setSendingTo(null);
  };

  const openFileDialog = () => {
    fileInputRef.current?.click();
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.header}>
          <div style={styles.logoWrapper}>
            <div style={styles.logo}>⚡</div>
          </div>
          <h1 style={styles.title}>WinDrop</h1>
          <p style={styles.subtitle}>Fast file transfers across your network</p>
        </div>

        <div
          style={{
            ...styles.dropZone,
            ...(isDragging ? styles.dropZoneDragging : {}),
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
          <div style={{
            ...styles.dropIcon,
            ...(isDragging ? styles.dropIconDragging : {}),
            ...(selectedFile ? styles.dropIconSelected : {}),
          }}>
            {isDragging ? "↓" : selectedFile ? "✓" : "+"}
          </div>
          <div style={styles.dropText}>
            {isDragging ? (
              <span style={{ color: "#f97316", fontWeight: 600 }}>Drop to send</span>
            ) : selectedFile ? (
              <div style={styles.fileInfo}>
                <span style={styles.fileName}>{selectedFile.name}</span>
                <span style={styles.fileSize}>
                  {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </span>
              </div>
            ) : (
              "Drop your file here"
            )}
          </div>
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
                  <span style={styles.modalLabel}>Sender:</span>
                  <span style={styles.modalValue}>{transferRequest.sender}</span>
                </div>
                <div style={styles.modalRow}>
                  <span style={styles.modalLabel}>File:</span>
                  <span style={styles.modalValue}>{transferRequest.filename}</span>
                </div>
                <div style={styles.modalRow}>
                  <span style={styles.modalLabel}>Size:</span>
                  <span style={styles.modalValue}>{(transferRequest.size / 1024 / 1024).toFixed(2)} MB</span>
                </div>
              </div>
              <div style={styles.modalFooter}>
                <button style={styles.rejectButton} onClick={() => handleDecision("reject")}>Reject</button>
                <button style={styles.acceptButton} onClick={() => handleDecision("accept")}>Accept</button>
              </div>
            </div>
          </div>
        )}

        {receivingProgress && (
          <div style={styles.progressContainer}>
            <div style={styles.progressHeader}>
              <span style={styles.progressTitle}>Receiving File...</span>
              <span style={styles.progressPercent}>
                {Math.round((receivingProgress.currentChunk / receivingProgress.totalChunks) * 100)}%
              </span>
            </div>
            <div style={styles.progressBarBg}>
              <div
                style={{
                  ...styles.progressBarFill,
                  width: `${(receivingProgress.currentChunk / receivingProgress.totalChunks) * 100}%`
                }}
              />
            </div>
            <div style={styles.progressDetails}>
              <span>Chunks: {receivingProgress.currentChunk} / {receivingProgress.totalChunks}</span>
            </div>
          </div>
        )}

        <div style={styles.statusBar}>
          {isSearching && (
            <div style={styles.searching}>
              <div style={styles.searchRing}>
                <div style={styles.searchDot} />
              </div>
              <span>Scanning network...</span>
            </div>
          )}
          {!isSearching && peers.length > 0 && (
            <div style={styles.deviceCount}>
              <span style={styles.count}>{peers.length}</span>
              <span>device{peers.length !== 1 ? "s" : ""} online</span>
            </div>
          )}
          {!isSearching && peers.length === 0 && (
            <div style={styles.noDevices}>No devices on network</div>
          )}
        </div>

        <div style={styles.devicesList}>
          {peers.map((peer) => {
            const isSending = sendingTo === peer.ip;
            const isDone = sendStatus?.ip === peer.ip;
            const success = isDone && sendStatus?.success;
            const failed = isDone && !sendStatus?.success;

            return (
              <div
                key={peer.ip}
                style={{
                  ...styles.deviceCard,
                  ...(success ? styles.deviceCardSuccess : {}),
                  ...(failed ? styles.deviceCardError : {}),
                }}
              >
                <div style={styles.deviceLeft}>
                  <div style={styles.deviceIcon}>📱</div>
                  <div style={styles.deviceInfo}>
                    <div style={styles.deviceName}>{peer.name}</div>
                    <div style={styles.deviceIp}>{peer.ip}</div>
                  </div>
                </div>
                <button
                  style={{
                    ...styles.sendButton,
                    ...(success ? styles.buttonSuccess : {}),
                    ...(failed ? styles.buttonError : {}),
                    ...(isSending ? styles.buttonSending : {}),
                    ...(!selectedFile ? styles.buttonDisabled : {}),
                  }}
                  onClick={() => handleSend(peer.ip)}
                  disabled={!selectedFile || isSending}
                >
                  {isSending ? (
                    <Spinner />
                  ) : success ? (
                    <AnimatedCheck />
                  ) : failed ? (
                    <FailedX />
                  ) : (
                    "Send"
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" style={{ animation: "windropSpin 0.8s linear infinite" }}>
      <style>{`@keyframes windropSpin { to { transform: rotate(360deg); } }`}</style>
      <circle cx="12" cy="12" r="10" stroke="white" strokeWidth="2.5" fill="none" opacity="0.3" />
      <path d="M12 2 A10 10 0 0 1 22 12" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function AnimatedCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <style>{`
        @keyframes windropCheck {
          0% { stroke-dashoffset: 30; opacity: 0; }
          20% { opacity: 1; }
          100% { stroke-dashoffset: 0; }
        }
        @keyframes windropPop {
          0% { transform: scale(0); }
          60% { transform: scale(1.3); }
          100% { transform: scale(1); }
        }
        .windrop-circle { animation: windropPop 0.3s ease forwards; transform-origin: center; }
        .windrop-path { animation: windropCheck 0.35s ease forwards 0.1s; stroke-dashoffset: 30; }
      `}</style>
      <circle className="windrop-circle" cx="12" cy="12" r="10" fill="#22c55e" />
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
    <svg width="18" height="18" viewBox="0 0 24 24">
      <style>{`@keyframes windropFail { from { opacity: 0; transform: scale(0.5); } to { opacity: 1; transform: scale(1); } }`}</style>
      <circle cx="12" cy="12" r="10" fill="#f43f5e" style={{ animation: "windropFail 0.2s ease" }} />
      <path d="M8 8l8 8M16 8l-8 8" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    background: "linear-gradient(160deg, #fef7ee 0%, #fdf4e7 100%)",
    padding: "60px 24px",
    fontFamily: "'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  card: {
    maxWidth: "420px",
    margin: "0 auto",
    background: "#ffffff",
    borderRadius: "32px",
    padding: "40px 28px",
    boxShadow: "0 4px 40px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.05)",
  },
  header: {
    textAlign: "center",
    marginBottom: "32px",
  },
  logoWrapper: {
    width: "72px",
    height: "72px",
    margin: "0 auto 16px",
    background: "linear-gradient(135deg, #f97316 0%, #ea580c 100%)",
    borderRadius: "22px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 8px 24px rgba(249, 115, 22, 0.35)",
  },
  logo: {
    fontSize: "36px",
  },
  title: {
    fontSize: "28px",
    fontWeight: "700",
    color: "#1a1a1a",
    margin: "0 0 6px 0",
    letterSpacing: "-0.5px",
  },
  subtitle: {
    fontSize: "15px",
    color: "#737373",
    margin: 0,
    fontWeight: "400",
  },
  dropZone: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    padding: "24px",
    background: "#fafafa",
    borderRadius: "20px",
    border: "2px dashed #e5e5e5",
    cursor: "pointer",
    transition: "all 0.2s ease",
    marginBottom: "20px",
  },
  dropZoneDragging: {
    borderColor: "#f97316",
    background: "#fff7ed",
    transform: "scale(1.02)",
  },
  dropIcon: {
    width: "48px",
    height: "48px",
    borderRadius: "14px",
    background: "#fff7ed",
    border: "2px solid #fed7aa",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "24px",
    color: "#f97316",
    fontWeight: "600",
    transition: "all 0.2s ease",
  },
  dropIconDragging: {
    transform: "scale(1.1)",
    borderColor: "#f97316",
  },
  dropIconSelected: {
    color: "#22c55e",
    borderColor: "#bbf7d0",
    background: "#f0fdf4",
  },
  dropText: {
    fontSize: "14px",
    color: "#737373",
    textAlign: "center",
  },
  fileInfo: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
  },
  fileName: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#1a1a1a",
    maxWidth: "240px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileSize: {
    fontSize: "12px",
    color: "#737373",
  },
  statusBar: {
    minHeight: "32px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: "20px",
  },
  searching: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    color: "#f97316",
    fontSize: "14px",
    fontWeight: "500",
  },
  searchRing: {
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    border: "2px solid #fed7aa",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    animation: "searchPulse 1.2s ease-in-out infinite",
  },
  searchDot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: "#f97316",
  },
  deviceCount: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    color: "#737373",
    fontSize: "14px",
  },
  count: {
    background: "#fff7ed",
    color: "#f97316",
    fontWeight: "700",
    padding: "2px 10px",
    borderRadius: "20px",
    fontSize: "13px",
  },
  noDevices: {
    color: "#a3a3a3",
    fontSize: "14px",
  },
  devicesList: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  deviceCard: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 18px",
    background: "#fafafa",
    borderRadius: "16px",
    border: "1.5px solid #f0f0f0",
    transition: "all 0.2s ease",
  },
  deviceCardSuccess: {
    borderColor: "#bbf7d0",
    background: "#f0fdf4",
  },
  deviceCardError: {
    borderColor: "#fecaca",
    background: "#fef2f2",
  },
  deviceLeft: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
  },
  deviceIcon: {
    width: "44px",
    height: "44px",
    borderRadius: "12px",
    background: "#fff7ed",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "22px",
  },
  deviceInfo: {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
  },
  deviceName: {
    fontSize: "15px",
    fontWeight: "600",
    color: "#1a1a1a",
  },
  deviceIp: {
    fontSize: "12px",
    color: "#a3a3a3",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
  },
  sendButton: {
    padding: "10px 22px",
    borderRadius: "12px",
    border: "none",
    background: "linear-gradient(135deg, #f97316 0%, #ea580c 100%)",
    color: "#ffffff",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "pointer",
    transition: "all 0.15s ease",
    minWidth: "75px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 2px 8px rgba(249, 115, 22, 0.3)",
  },
  buttonSuccess: {
    background: "#22c55e",
    boxShadow: "0 2px 8px rgba(34, 197, 94, 0.3)",
  },
  buttonError: {
    background: "#f43f5e",
    boxShadow: "0 2px 8px rgba(244, 63, 94, 0.3)",
  },
  buttonSending: {
    background: "#d4d4d4",
    boxShadow: "none",
    cursor: "not-allowed",
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  modalOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0, 0, 0, 0.4)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "#fff",
    width: "320px",
    borderRadius: "24px",
    padding: "24px",
    boxShadow: "0 20px 40px rgba(0, 0, 0, 0.2)",
    animation: "modalPop 0.3s ease-out",
  },
  modalHeader: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    marginBottom: "20px",
  },
  modalIcon: {
    width: "40px",
    height: "400px",
    background: "#fff7ed",
    borderRadius: "10px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "20px",
  },
  modalTitle: {
    fontSize: "20px",
    fontWeight: "700",
    margin: 0,
    color: "#1a1a1a",
  },
  modalBody: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    marginBottom: "24px",
  },
  modalRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "14px",
  },
  modalLabel: {
    color: "#737373",
  },
  modalValue: {
    fontWeight: "600",
    color: "#1a1a1a",
  },
  modalFooter: {
    display: "flex",
    gap: "12px",
  },
  rejectButton: {
    flex: 1,
    padding: "12px",
    borderRadius: "12px",
    border: "1px solid #e5e5e5",
    background: "#fff",
    color: "#737373",
    fontWeight: "600",
    cursor: "pointer",
    transition: "all 0.2s ease",
  },
  acceptButton: {
    flex: 1,
    padding: "12px",
    borderRadius: "12px",
    border: "none",
    background: "linear-gradient(135deg, #f97316 0%, #ea580c 100%)",
    color: "#fff",
    fontWeight: "600",
    cursor: "pointer",
    transition: "all 0.2s ease",
  },
  progressContainer: {
    background: "#fff",
    borderRadius: "20px",
    padding: "16px",
    marginBottom: "20px",
    border: "1px solid #f0f0f0",
    boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
  },
  progressHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "8px",
  },
  progressTitle: {
    fontSize: "14px",
    fontWeight: "600",
    color: "#1a1a1a",
  },
  progressPercent: {
    fontSize: "14px",
    fontWeight: "700",
    color: "#f97316",
  },
  progressBarBg: {
    height: "8px",
    background: "#f0f0f0",
    borderRadius: "4px",
    overflow: "hidden",
    marginBottom: "8px",
  },
  progressBarFill: {
    height: "100%",
    background: "linear-gradient(90deg, #f97316, #ea580c)",
    transition: "width 0.3s ease",
  },
  progressDetails: {
    fontSize: "12px",
    color: "#737373",
    textAlign: "center",
  },
};

const globalStyles = `
  @keyframes searchPulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.15); opacity: 0.7; }
  }
  @keyframes modalPop {
    from { transform: scale(0.9); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }
  body { margin: 0; background: #fef7ee; }
  * { box-sizing: border-box; }
`;

if (!document.getElementById("windrop-styles")) {
  const styleSheet = document.createElement("style");
  styleSheet.id = "windrop-styles";
  styleSheet.textContent = globalStyles;
  document.head.appendChild(styleSheet);
}

export default App;
