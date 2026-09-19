import React, { useEffect, useState, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import axios from "axios";

const API_BASE =
  typeof window !== "undefined"
    ? `http://${window.location.hostname}:5000`
    : "http://localhost:5000";

function App() {
  const socketRef = useRef(null);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const completionTimerRef = useRef(null);
  const folderCompletionTimerRef = useRef(null);
  const errorTimerRef = useRef(null);

  const [peers, setPeers] = useState([]);
  const [manualPeers, setManualPeers] = useState([]);
  const [manualIp, setManualIp] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [folderFiles, setFolderFiles] = useState([]);
  const [isSearching, setIsSearching] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [dragCounter, setDragCounter] = useState(0);
  const [activeTransfers, setActiveTransfers] = useState({});
  const [transferRequest, setTransferRequest] = useState(null);
  const [folderRequest, setFolderRequest] = useState(null);
  const [transferError, setTransferError] = useState(null);
  const [history, setHistory] = useState([]);
  const [backendConnected, setBackendConnected] = useState(false);

  // Receiving file state is intentionally separated from its terminal state.
  // The backend's completion event has no chunk counters, so it must never be
  // passed through the percentage calculation.
  const [receiving, setReceiving] = useState(null);

  // Folder receive progress can contain file-level progress as well as an
  // overall filesCompleted/fileCount view.
  const [receivingFolder, setReceivingFolder] = useState(null);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/transfers`);
      setHistory(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error("Failed to fetch history", err);
    }
  }, []);

  const showError = useCallback((data) => {
    setTransferError({
      code: data?.code || "TRANSFER_ERROR",
      message: data?.message || "The transfer could not be completed.",
    });

    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      setTransferError(null);
    }, 6000);
  }, []);

  useEffect(() => {
    const socket = io(API_BASE);
    socketRef.current = socket;

    const onConnect = () => setBackendConnected(true);
    const onDisconnect = () => setBackendConnected(false);
    const onConnectError = (err) => {
      console.error("Backend connection error:", err.message, "— tried:", API_BASE);
      setBackendConnected(false);
    };

    const onPeersList = (peerList) => {
      setPeers(Array.isArray(peerList) ? peerList : []);
      setIsSearching(false);
    };

    const onIncomingTransferRequest = (data) => {
      setTransferRequest(data);
      setFolderRequest(null);
      setReceiving(null);
    };

    const onIncomingFolderRequest = (data) => {
      setFolderRequest(data);
      setTransferRequest(null);
      setReceivingFolder(null);
    };

    const onTransferProgress = (data) => {
      if (data?.status === "completed") {
        setReceiving((prev) => ({
          phase: "done",
          filename: prev?.filename || data.filename || "File",
        }));
        fetchHistory();

        if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
        completionTimerRef.current = setTimeout(() => {
          setReceiving(null);
        }, 4000);
        return;
      }

      if (data?.status === "failed" || data?.status === "error") {
        setReceiving(null);
        showError(data);
        fetchHistory();
        return;
      }

      if (
        Number.isFinite(Number(data?.currentChunk)) &&
        Number.isFinite(Number(data?.totalChunks))
      ) {
        setReceiving((prev) => ({
          phase: "active",
          currentChunk: Number(data.currentChunk),
          totalChunks: Math.max(1, Number(data.totalChunks)),
          filename: prev?.filename || data.filename,
        }));
      }
    };

    const onFolderProgress = (data) => {
      if (data?.status === "completed") {
        setReceivingFolder((prev) => ({
          phase: "done",
          folderName: prev?.folderName || data.folderName || "Folder",
          filesCompleted: Number(data.filesCompleted ?? data.fileCount ?? 0),
          fileCount: Number(data.fileCount ?? data.filesCompleted ?? 0),
          currentFile: data.currentFile || prev?.currentFile,
          fileProgress: 100,
        }));
        fetchHistory();

        if (folderCompletionTimerRef.current) {
          clearTimeout(folderCompletionTimerRef.current);
        }
        folderCompletionTimerRef.current = setTimeout(() => {
          setReceivingFolder(null);
        }, 4000);
        return;
      }

      if (data?.status === "failed" || data?.status === "error") {
        setReceivingFolder(null);
        showError(data);
        fetchHistory();
        return;
      }

      setReceivingFolder((prev) => ({
        phase: "active",
        folderName: prev?.folderName || data.folderName || data.filename || "Folder",
        filesCompleted: Math.max(0, Number(data.filesCompleted ?? prev?.filesCompleted ?? 0)),
        fileCount: Math.max(1, Number(data.fileCount ?? prev?.fileCount ?? 1)),
        currentFile: data.currentFile ?? prev?.currentFile ?? null,
        fileProgress:
          Number.isFinite(Number(data.fileProgress))
            ? Math.max(0, Math.min(100, Number(data.fileProgress)))
            : prev?.fileProgress ?? 0,
      }));
    };

    const onTransferError = (data) => {
      showError(data);
      setReceiving(null);
      setReceivingFolder(null);
      fetchHistory();
    };

    const onSendingProgress = (data) => {
      if (!data?.transferId) return;
      setActiveTransfers((prev) => ({
        ...prev,
        [data.transferId]: {
          filename: data.filename || prev[data.transferId]?.filename || "File",
          progress: Math.max(0, Math.min(100, Number(data.progress ?? 0))),
          status: data.status || "sending",
        },
      }));

      if (data.status === "completed" || data.status === "failed") {
        fetchHistory();
      }
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("peers_list", onPeersList);
    socket.on("incoming-transfer-request", onIncomingTransferRequest);
    socket.on("incoming-folder-request", onIncomingFolderRequest);
    socket.on("transfer-progress", onTransferProgress);
    socket.on("folder-progress", onFolderProgress);
    socket.on("transfer-error", onTransferError);
    socket.on("sending-progress", onSendingProgress);

    fetchHistory();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("peers_list", onPeersList);
      socket.off("incoming-transfer-request", onIncomingTransferRequest);
      socket.off("incoming-folder-request", onIncomingFolderRequest);
      socket.off("transfer-progress", onTransferProgress);
      socket.off("folder-progress", onFolderProgress);
      socket.off("transfer-error", onTransferError);
      socket.off("sending-progress", onSendingProgress);
      socket.disconnect();

      if (completionTimerRef.current) clearTimeout(completionTimerRef.current);
      if (folderCompletionTimerRef.current) clearTimeout(folderCompletionTimerRef.current);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, [fetchHistory, showError]);

  const handleAddManualPeer = () => {
    const ip = manualIp.trim();
    if (!ip) return;

    const octets = ip.split(".");
    const validIpv4 =
      octets.length === 4 &&
      octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);

    if (!validIpv4) {
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
      setReceiving({
        phase: "active",
        currentChunk: 0,
        totalChunks: 1,
        filename: req.filename,
      });
    }

    try {
      await axios.post(`${API_BASE}/transfer/decision`, {
        id: req.id,
        decision,
        isFolder: false,
      });
    } catch (err) {
      console.error("Decision failed", err);
      setReceiving(null);
      showError({
        code: "DECISION_FAILED",
        message: err?.response?.data?.message || "Could not send the transfer decision.",
      });
    }
  };

  const handleFolderDecision = async (decision) => {
    if (!folderRequest) return;

    const req = folderRequest;
    setFolderRequest(null);

    if (decision === "accept") {
      setReceivingFolder({
        phase: "active",
        folderName: req.folderName,
        filesCompleted: 0,
        fileCount: Math.max(1, Number(req.fileCount || 1)),
        currentFile: null,
        fileProgress: 0,
      });
    }

    try {
      await axios.post(`${API_BASE}/transfer/decision`, {
        id: req.id,
        decision,
        isFolder: true,
      });
    } catch (err) {
      console.error("Folder decision failed", err);
      setReceivingFolder(null);
      showError({
        code: "FOLDER_DECISION_FAILED",
        message: err?.response?.data?.message || "Could not send the folder decision.",
      });
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
      const next = Math.max(0, prev - 1);
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

    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 1) {
      setSelectedFile(files[0]);
      setSelectedFolder(null);
      setFolderFiles([]);
      return;
    }

    // Do not treat a multi-file drag as a folder transfer. Browsers do not
    // consistently preserve webkitRelativePath for a dragged directory, so
    // doing so could silently flatten the folder structure on the receiver.
    if (files.length > 1) {
      setTransferError({
        code: "FOLDER_SELECTION_REQUIRED",
        message: "Use “Choose Folder” to preserve subdirectories when sending a folder.",
      });
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setTransferError(null), 6000);
    }
  }, []);

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    setSelectedFolder(null);
    setFolderFiles([]);
    e.target.value = "";
  };

  const handleFolderSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const firstPath = files[0].webkitRelativePath || files[0].name;
    const folderName = firstPath.includes("/") ? firstPath.split("/")[0] : "Selected folder";

    setSelectedFolder(folderName);
    setFolderFiles(files);
    setSelectedFile(null);
    e.target.value = "";
  };

  const handleSend = async (targetIp) => {
    if (!selectedFile) return;

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("targetIp", targetIp);

    try {
      const res = await axios.post(`${API_BASE}/send`, formData);
      if (res.data?.transferId) {
        setActiveTransfers((prev) => ({
          ...prev,
          [res.data.transferId]: {
            filename: selectedFile.name,
            progress: 0,
            status: "sending",
          },
        }));
      }
    } catch (err) {
      console.error("File send failed", err);
      showError({
        code: "SEND_FAILED",
        message: err?.response?.data?.message || "Could not start the file transfer.",
      });
    }
  };

  const handleSendFolder = async (targetIp) => {
    if (!folderFiles.length) return;

    const formData = new FormData();
    folderFiles.forEach((file) => {
      // IMPORTANT: the relative path must be used as the multipart filename.
      // The backend relies on req.files[].originalname to rebuild folders.
      formData.append("files", file, file.webkitRelativePath || file.name);
    });
    formData.append("targetIp", targetIp);
    formData.append("folderName", selectedFolder || "Selected folder");

    try {
      const res = await axios.post(`${API_BASE}/send-folder`, formData);
      const transferId = res.data?.transferId;

      if (transferId) {
        setActiveTransfers((prev) => ({
          ...prev,
          [transferId]: {
            filename: `${selectedFolder || "Folder"} (${folderFiles.length} files)`,
            progress: 0,
            status: "sending",
          },
        }));
      }
    } catch (err) {
      console.error("Folder send failed", err);
      showError({
        code: "FOLDER_SEND_FAILED",
        message: err?.response?.data?.message || "Could not start the folder transfer.",
      });
    }
  };

  const openFileDialog = () => fileInputRef.current?.click();
  const openFolderDialog = () => folderInputRef.current?.click();

  const clearSelection = () => {
    setSelectedFile(null);
    setSelectedFolder(null);
    setFolderFiles([]);
  };

  const totalDevices = peers.length + manualPeers.length;

  const receivingPercent =
    receiving?.phase === "active" && receiving.totalChunks > 0
      ? Math.min(100, Math.round((receiving.currentChunk / receiving.totalChunks) * 100))
      : 0;

  const folderOverallPercent = receivingFolder
    ? Math.min(
        100,
        Math.round(
          ((receivingFolder.filesCompleted +
            (receivingFolder.fileProgress > 0 ? receivingFolder.fileProgress / 100 : 0)) /
            Math.max(1, receivingFolder.fileCount)) *
            100,
        ),
      )
    : 0;

  return (
    <>
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
            <span
              style={{
                ...styles.dot,
                background: backendConnected ? "#34d399" : "#fb7185",
              }}
            />
            <span style={{ color: backendConnected ? "#a7f3d0" : "#fda4af" }}>
              {backendConnected
                ? "Connected to backend"
                : "Not connected — check the backend is running"}
            </span>
          </div>

          <div
            style={{
              ...styles.dropZone,
              ...(isDragging ? styles.dropZoneActive : {}),
              ...(selectedFile || selectedFolder ? styles.dropZoneSelected : {}),
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
              onChange={handleFileSelect}
              style={{ display: "none" }}
            />
            <div
              style={{
                ...styles.dropIcon,
                ...(isDragging ? styles.dropIconActive : {}),
                ...(selectedFile || selectedFolder ? styles.dropIconSelected : {}),
              }}
            >
              {isDragging ? "↓" : selectedFile || selectedFolder ? "✓" : "+"}
            </div>

            {isDragging ? (
              <span style={styles.dropHint}>Drop to select</span>
            ) : selectedFile ? (
              <div style={styles.fileInfo}>
                <span style={styles.fileName}>{selectedFile.name}</span>
                <span style={styles.fileSize}>
                  {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </span>
              </div>
            ) : selectedFolder ? (
              <div style={styles.fileInfo}>
                <span style={styles.fileName}>{selectedFolder}</span>
                <span style={styles.fileSize}>
                  {folderFiles.length} file{folderFiles.length !== 1 ? "s" : ""}
                </span>
              </div>
            ) : (
              <span style={styles.dropHint}>Drop a file here, or click to browse</span>
            )}
          </div>

          <div style={styles.selectionActions}>
            <button type="button" onClick={openFileDialog} style={styles.secondaryButton}>
              Choose File
            </button>
            <button type="button" onClick={openFolderDialog} style={styles.secondaryButton}>
              Choose Folder
            </button>
            {(selectedFile || selectedFolder) && (
              <button type="button" onClick={clearSelection} style={styles.clearButton}>
                Clear
              </button>
            )}
            <input
              ref={folderInputRef}
              type="file"
              webkitdirectory="true"
              directory=""
              multiple
              onChange={handleFolderSelect}
              style={{ display: "none" }}
            />
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
              {receiving.filename && (
                <div style={styles.progressFilename}>{receiving.filename}</div>
              )}
              {receiving.phase === "active" && (
                <div style={styles.progressBarBg}>
                  <div style={{ ...styles.progressBarFill, width: `${receivingPercent}%` }} />
                </div>
              )}
            </div>
          )}

          {receivingFolder && (
            <div style={styles.progressCard}>
              <div style={styles.progressHeaderRow}>
                <div style={styles.progressHeaderLeft}>
                  {receivingFolder.phase === "active" ? <Spinner /> : <AnimatedCheck />}
                  <span style={styles.progressTitle}>
                    {receivingFolder.phase === "active"
                      ? "Receiving folder…"
                      : "Folder received successfully"}
                  </span>
                </div>
                <span style={styles.progressPercent}>{folderOverallPercent}%</span>
              </div>

              <div style={styles.progressFilename}>{receivingFolder.folderName}</div>

              <div style={styles.folderProgressMeta}>
                <span>
                  {Math.min(receivingFolder.filesCompleted, receivingFolder.fileCount)} of {receivingFolder.fileCount} files
                </span>
                {receivingFolder.currentFile && (
                  <span style={styles.currentFileText}>{receivingFolder.currentFile}</span>
                )}
              </div>

              {receivingFolder.phase === "active" && (
                <div style={styles.progressBarBg}>
                  <div
                    style={{ ...styles.progressBarFill, width: `${folderOverallPercent}%` }}
                  />
                </div>
              )}

              {receivingFolder.phase === "active" && receivingFolder.currentFile && (
                <div style={styles.fileProgressText}>
                  Current file: {Math.round(receivingFolder.fileProgress || 0)}%
                </div>
              )}
            </div>
          )}

          {Object.entries(activeTransfers).length > 0 && (
            <div style={styles.progressCard}>
              <div style={styles.progressTitle}>Sending</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginTop: "10px" }}>
                {Object.entries(activeTransfers).map(([id, transfer]) => (
                  <div key={id}>
                    <div style={styles.progressHeaderRow}>
                      <div style={styles.progressHeaderLeft}>
                        {transfer.status === "completed" ? (
                          <AnimatedCheck />
                        ) : transfer.status === "failed" ? (
                          <FailedX />
                        ) : (
                          <Spinner />
                        )}
                        <span style={styles.sendingFilename}>{transfer.filename}</span>
                      </div>
                      <span style={styles.progressPercent}>
                        {transfer.status === "completed"
                          ? "100%"
                          : transfer.status === "failed"
                          ? "Failed"
                          : `${transfer.progress}%`}
                      </span>
                    </div>
                    <div style={styles.progressBarBg}>
                      <div
                        style={{
                          ...styles.progressBarFill,
                          background:
                            transfer.status === "completed"
                              ? "linear-gradient(90deg, #34d399, #10b981)"
                              : transfer.status === "failed"
                              ? "#fb7185"
                              : "linear-gradient(90deg, #818cf8, #6366f1)",
                          width:
                            transfer.status === "completed"
                              ? "100%"
                              : transfer.status === "failed"
                              ? "100%"
                              : `${transfer.progress}%`,
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
            <button type="button" onClick={handleAddManualPeer} style={styles.manualButton}>
              Add
            </button>
          </div>

          <div style={styles.devicesList}>
            {[...peers, ...manualPeers].map((peer) => (
              <div key={peer.ip} style={styles.deviceCard}>
                <div style={styles.deviceLeft}>
                  <div style={styles.deviceIcon}>{peer.manual ? "🖥️" : "📱"}</div>
                  <div>
                    <div style={styles.deviceName}>{peer.name || "Unknown device"}</div>
                    <div style={styles.deviceIp}>{peer.ip}</div>
                  </div>
                </div>

                <div style={styles.deviceActions}>
                  <button
                    type="button"
                    style={{
                      ...styles.sendButton,
                      ...(!selectedFile ? styles.sendButtonDisabled : {}),
                    }}
                    onClick={() => handleSend(peer.ip)}
                    disabled={!selectedFile}
                  >
                    Send File
                  </button>
                  <button
                    type="button"
                    style={{
                      ...styles.folderSendButton,
                      ...(!folderFiles.length ? styles.sendButtonDisabled : {}),
                    }}
                    onClick={() => handleSendFolder(peer.ip)}
                    disabled={!folderFiles.length}
                  >
                    Send Folder
                  </button>
                </div>
              </div>
            ))}
          </div>

          {history.length > 0 && (
            <div style={styles.historySection}>
              <h3 style={styles.historyTitle}>Recent Transfers</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {history.slice(0, 6).map((item) => (
                  <div key={item.id} style={styles.historyItem}>
                    <div style={styles.historyIcon}>
                      {item.direction === "received" ? "⬇️" : "⬆️"}
                    </div>
                    <div style={styles.historyFileInfo}>
                      <span style={styles.historyFileName}>{item.filename}</span>
                      <span style={styles.historyFileMeta}>
                        {item.direction === "received"
                          ? `From ${item.sender ?? "peer"}`
                          : `To ${item.targetIp}`}
                        {" • "}
                        {Number.isFinite(Number(item.size))
                          ? `${(Number(item.size) / 1024 / 1024).toFixed(2)} MB`
                          : "Unknown size"}
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
                      {String(item.status || "pending").toUpperCase()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {transferRequest && (
        <div style={styles.modalOverlay} role="dialog" aria-modal="true">
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <div style={styles.modalIcon}>📄</div>
              <h2 style={styles.modalTitle}>Incoming File</h2>
            </div>
            <div style={styles.modalBody}>
              <div style={styles.modalRow}>
                <span style={styles.modalLabel}>Sender</span>
                <span style={styles.modalValue}>{transferRequest.sender || "peer"}</span>
              </div>
              <div style={styles.modalRow}>
                <span style={styles.modalLabel}>File</span>
                <span style={styles.modalValue}>{transferRequest.filename || "Unknown file"}</span>
              </div>
              <div style={styles.modalRow}>
                <span style={styles.modalLabel}>Size</span>
                <span style={styles.modalValue}>
                  {Number.isFinite(Number(transferRequest.size))
                    ? `${(Number(transferRequest.size) / 1024 / 1024).toFixed(2)} MB`
                    : "Unknown"}
                </span>
              </div>
            </div>
            <div style={styles.modalFooter}>
              <button type="button" style={styles.rejectButton} onClick={() => handleDecision("reject")}>
                Reject
              </button>
              <button type="button" style={styles.acceptButton} onClick={() => handleDecision("accept")}>
                Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {folderRequest && (
        <div style={styles.modalOverlay} role="dialog" aria-modal="true">
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <div style={styles.modalIcon}>📦</div>
              <h2 style={styles.modalTitle}>Incoming Folder</h2>
            </div>
            <div style={styles.modalBody}>
              <div style={styles.modalRow}>
                <span style={styles.modalLabel}>Sender</span>
                <span style={styles.modalValue}>{folderRequest.sender || "peer"}</span>
              </div>
              <div style={styles.modalRow}>
                <span style={styles.modalLabel}>Folder</span>
                <span style={styles.modalValue}>{folderRequest.folderName || "Unknown folder"}</span>
              </div>
              <div style={styles.modalRow}>
                <span style={styles.modalLabel}>Files</span>
                <span style={styles.modalValue}>{folderRequest.fileCount ?? "Unknown"}</span>
              </div>
              <div style={styles.modalRow}>
                <span style={styles.modalLabel}>Size</span>
                <span style={styles.modalValue}>
                  {Number.isFinite(Number(folderRequest.totalSize))
                    ? `${(Number(folderRequest.totalSize) / 1024 / 1024).toFixed(2)} MB`
                    : "Unknown"}
                </span>
              </div>
            </div>
            <div style={styles.modalFooter}>
              <button type="button" style={styles.rejectButton} onClick={() => handleFolderDecision("reject")}>
                Reject
              </button>
              <button type="button" style={styles.acceptButton} onClick={() => handleFolderDecision("accept")}>
                Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {transferError && (
        <div style={styles.errorToast} role="alert">
          <span style={{ fontSize: "18px" }}>⚠️</span>
          <div>
            <div style={styles.errorCode}>{transferError.code}</div>
            <div style={styles.errorMessage}>{transferError.message}</div>
          </div>
        </div>
      )}
    </>
  );
}

function Spinner() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      style={{ animation: "windropSpin 0.8s linear infinite", flexShrink: 0 }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="#818cf8" strokeWidth="2.5" fill="none" opacity="0.25" />
      <path d="M12 2 A10 10 0 0 1 22 12" stroke="#818cf8" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function AnimatedCheck() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }} aria-hidden="true">
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
    <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }} aria-hidden="true">
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
    maxWidth: "560px",
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
    marginBottom: "12px",
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
    maxWidth: "360px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileSize: { fontSize: "12px", color: "#94a3b8" },
  selectionActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    marginBottom: "16px",
  },
  secondaryButton: {
    flex: "1 1 130px",
    minWidth: "120px",
    padding: "10px 14px",
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.05)",
    color: "#e2e8f0",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
  },
  clearButton: {
    padding: "10px 14px",
    borderRadius: "10px",
    border: "1px solid rgba(251,113,133,0.2)",
    background: "rgba(251,113,133,0.06)",
    color: "#fda4af",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
  },
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
    gap: "10px",
  },
  progressHeaderLeft: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
  progressTitle: { fontSize: "13px", fontWeight: 600, color: "#e2e8f0" },
  sendingFilename: {
    fontSize: "12px",
    color: "#cbd5e1",
    maxWidth: "320px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  progressFilename: {
    fontSize: "12px",
    color: "#94a3b8",
    marginTop: "4px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  progressPercent: { fontSize: "12px", fontWeight: 700, color: "#a5b4fc", flexShrink: 0 },
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
  folderProgressMeta: {
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    marginTop: "8px",
    color: "#cbd5e1",
    fontSize: "11px",
  },
  currentFileText: {
    color: "#94a3b8",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  fileProgressText: { marginTop: "7px", color: "#64748b", fontSize: "11px" },
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
    gap: "12px",
    padding: "14px 16px",
    background: "rgba(255,255,255,0.02)",
    borderRadius: "14px",
    border: "1px solid rgba(255,255,255,0.06)",
    transition: "all 0.2s ease",
  },
  deviceLeft: { display: "flex", alignItems: "center", gap: "12px", minWidth: 0 },
  deviceIcon: {
    width: "38px",
    height: "38px",
    borderRadius: "11px",
    background: "rgba(255,255,255,0.04)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "18px",
    flexShrink: 0,
  },
  deviceName: { fontSize: "14px", fontWeight: 600, color: "#f1f5f9" },
  deviceIp: { fontSize: "11px", color: "#64748b", fontFamily: "'SF Mono', 'Fira Code', monospace" },
  deviceActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    justifyContent: "flex-end",
  },
  sendButton: {
    padding: "8px 12px",
    borderRadius: "10px",
    border: "none",
    background: "linear-gradient(135deg, #818cf8, #6366f1)",
    color: "#fff",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(99, 102, 241, 0.35)",
    transition: "all 0.15s ease",
  },
  folderSendButton: {
    padding: "8px 12px",
    borderRadius: "10px",
    border: "none",
    background: "linear-gradient(135deg, #22c55e, #16a34a)",
    color: "#fff",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(34, 197, 94, 0.25)",
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
    maxWidth: "360px",
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
  modalRow: { display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "13px" },
  modalLabel: { color: "#94a3b8" },
  modalValue: { fontWeight: 600, color: "#f1f5f9", textAlign: "right", marginLeft: "12px", overflow: "hidden", textOverflow: "ellipsis" },
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
  button:focus-visible, input:focus-visible { outline: 2px solid rgba(129, 140, 248, 0.65); outline-offset: 2px; }
  @media (max-width: 620px) {
    .windrop-device-card { flex-direction: column; align-items: stretch !important; }
  }
`;

if (typeof document !== "undefined" && !document.getElementById("windrop-styles")) {
  const styleSheet = document.createElement("style");
  styleSheet.id = "windrop-styles";
  styleSheet.textContent = globalStyles;
  document.head.appendChild(styleSheet);
}

export default App;
