// MicroGit の最小ゲストの init 兼 agent（Issue #15, #17）。
//
// カーネルは initramfs の /init としてこれを PID 1 で起動する。ゲストのユーザーランドはこの 1 ファイルだけで、
// シェルは入れない（AD-7）。PID 1 が終わるとカーネルがパニックするので、main は戻らない。
//
// ホストとは virtio-console の名前付きポート "microgit" でつながる。1 行 1 つの JSON で要求を受け、
// 1 行 1 つの JSON で答える（要求と応答は 1 対 1、順番どおり）。命令の形は仮のもので、正式には #12 で決める。
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	agentVersion = "0.2.0"
	portName     = "microgit"
	stateRoot    = "/run/microgit"
)

type request struct {
	ID     int        `json:"id"`
	Op     string     `json:"op"`
	Parent *int       `json:"parent,omitempty"`
	Ops    [][]string `json:"ops,omitempty"`
	Commit *int       `json:"commit,omitempty"`
	Path   string     `json:"path,omitempty"`
}

type response struct {
	ID    int    `json:"id,omitempty"`
	Event string `json:"event,omitempty"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`

	Kernel       string   `json:"kernel,omitempty"`
	Agent        string   `json:"agent,omitempty"`
	Commit       *int     `json:"commit,omitempty"`
	MountOptions string   `json:"mountOptions,omitempty"`
	ExdevRenames int      `json:"exdevRenames,omitempty"`
	Entries      []string `json:"entries,omitempty"`
	Content      *string  `json:"content,omitempty"`
	ElapsedUs    int64    `json:"elapsedUs,omitempty"`
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stdout, "microgit-agent: "+format+"\n", args...)
}

func main() {
	if os.Getpid() != 1 {
		runStdio()
		return
	}
	if err := setupSystem(); err != nil {
		fatal(err)
	}
	store, err := newStore(stateRoot)
	if err != nil {
		fatal(err)
	}
	port, err := findPort(portName, 10*time.Second)
	if err != nil {
		fatal(err)
	}
	logf("ready kernel=%s port=%s", kernelRelease(), port)
	for {
		if err := serve(port, store); err != nil {
			logf("port error: %v", err)
		}
		// ホスト側が閉じていると EOF になる。つなぎ直しを待つ
		time.Sleep(200 * time.Millisecond)
	}
}

func fatal(err error) {
	logf("fatal: %v", err)
	powerOff()
}

func powerOff() {
	syscall.Sync()
	// PSCI の SYSTEM_OFF になり、QEMU も Virtualization.framework も VM を止める
	_ = syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF)
	select {}
}

func setupSystem() error {
	mounts := []struct{ src, target, fstype, data string }{
		{"proc", "/proc", "proc", ""},
		{"sysfs", "/sys", "sysfs", ""},
		{"devtmpfs", "/dev", "devtmpfs", ""},
		{"tmpfs", "/run", "tmpfs", "mode=0755"},
	}
	for _, m := range mounts {
		if err := os.MkdirAll(m.target, 0o755); err != nil {
			return err
		}
		if err := syscall.Mount(m.src, m.target, m.fstype, 0, m.data); err != nil {
			return fmt.Errorf("mount %s: %w", m.target, err)
		}
	}
	return nil
}

// findPort は名前が一致する virtio-console ポートのデバイスパスを返す。
// QEMU では /dev/vport0p1、Virtualization.framework では /dev/vport1p0 のように番号が環境で変わるため、名前で探す。
func findPort(name string, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	for {
		names, _ := filepath.Glob("/sys/class/virtio-ports/*/name")
		for _, n := range names {
			b, err := os.ReadFile(n)
			if err == nil && strings.TrimSpace(string(b)) == name {
				return "/dev/" + filepath.Base(filepath.Dir(n)), nil
			}
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("virtio-console port %q not found", name)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func kernelRelease() string {
	var u syscall.Utsname
	if err := syscall.Uname(&u); err != nil {
		return "unknown"
	}
	var b strings.Builder
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		b.WriteByte(byte(c))
	}
	return b.String()
}

// runStdio は PID 1 以外で起動されたときの動き。VM を使わずに、同じ命令を stdin/stdout で受ける。
// Linux ホストでは `unshare -Urm <agent>` で非特権のまま OverlayFS を使える（AD-2 のネイティブ経路の原型）。
// 層は一時ディレクトリに置き、poweroff か stdin の終わりで片付ける。
func runStdio() {
	root, err := os.MkdirTemp("", "microgit-agent-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	s, err := newStore(root)
	if err == nil {
		err = serveStream(os.Stdin, os.Stdout, s, func() {})
	}
	_ = s.reset()
	_ = os.RemoveAll(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func serve(port string, store *store) error {
	f, err := os.OpenFile(port, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return serveStream(f, f, store, powerOff)
}

// serveStream は 1 行 1 JSON の要求を読み、応答を返す。poweroff を受けたら応答してから onPowerOff を呼んで戻る。
func serveStream(r io.Reader, w io.Writer, store *store, onPowerOff func()) error {
	enc := json.NewEncoder(w)
	if err := enc.Encode(response{Event: "ready", OK: true, Kernel: kernelRelease(), Agent: agentVersion}); err != nil {
		return err
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for sc.Scan() {
		var req request
		var res response
		start := time.Now()
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			res = response{Error: "bad request: " + err.Error()}
		} else {
			res = handle(store, req)
			res.ID = req.ID
		}
		res.ElapsedUs = time.Since(start).Microseconds()
		if err := enc.Encode(res); err != nil {
			return err
		}
		if req.Op == "poweroff" {
			onPowerOff()
			return nil
		}
	}
	if err := sc.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

func handle(s *store, req request) response {
	switch req.Op {
	case "hello":
		return response{OK: true, Kernel: kernelRelease(), Agent: agentVersion}
	case "reset":
		if err := s.reset(); err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true}
	case "commit":
		parent := -1
		if req.Parent != nil {
			parent = *req.Parent
		}
		id, info, err := s.commit(parent, req.Ops)
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true, Commit: &id, MountOptions: info.mountOptions, ExdevRenames: info.exdevRenames}
	case "view":
		if req.Commit == nil {
			return response{Error: "view needs commit"}
		}
		entries, err := s.view(*req.Commit)
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true, Entries: entries}
	case "read":
		if req.Commit == nil || req.Path == "" {
			return response{Error: "read needs commit and path"}
		}
		content, err := s.read(*req.Commit, req.Path)
		if err != nil {
			return response{Error: err.Error()}
		}
		return response{OK: true, Content: &content}
	case "poweroff":
		return response{OK: true}
	default:
		return response{Error: "unknown op: " + req.Op}
	}
}
