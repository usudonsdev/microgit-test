package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// store はコミットを OverlayFS の層として持つ。
//
// モデルは scripts/golden/record-kernel.mjs と同じ（要件定義書 FR-2 の初期案）:
//   コミット = 祖先の層を lowerdir に積み、空の upperdir に ops を書いて unmount したもの。
//   凍結した upper がそのまま子の lower になる。view は祖先＋自分の層だけの読み取り専用 mount。
//
// 層はゲストの tmpfs（/run/microgit）に置く。upperdir の置き場所（O-2）は #17 で決めるまでの仮。
// 電源を切ると消えるので、今はゴールデンテストと計測のためだけに使う。
type store struct {
	root    string
	parents []int // parents[id] = 親のコミット番号（最初は -1）
}

type commitInfo struct {
	mountOptions string
	exdevRenames int
}

// mount オプション。record-kernel.mjs の MOUNT_OPTS と揃える（期待値を記録した条件と同じにするため）。
// 固定する値は #12（O-13）で決める。
const overlayOpts = "userxattr"

func newStore(root string) (*store, error) {
	s := &store{root: root}
	return s, s.reset()
}

func (s *store) mnt() string        { return filepath.Join(s.root, "m") }
func (s *store) upper(id int) string { return filepath.Join(s.root, fmt.Sprintf("u%d", id)) }
func (s *store) work(id int) string  { return filepath.Join(s.root, fmt.Sprintf("w%d", id)) }
func (s *store) base() string        { return filepath.Join(s.root, "base") }

func (s *store) reset() error {
	_ = syscall.Unmount(s.mnt(), 0)
	if err := os.RemoveAll(s.root); err != nil {
		return err
	}
	s.parents = nil
	for _, d := range []string{s.base(), s.mnt()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

// lowerdirs は id から最初のコミットまでの層を、上の層が先の順で返す。最後は空の base。
// 読み取り専用の overlay は lowerdir が 2 つ以上いるので、base を必ず足す。
func (s *store) lowerdirs(id int) []string {
	var dirs []string
	for n := id; n >= 0; n = s.parents[n] {
		dirs = append(dirs, s.upper(n))
	}
	return append(dirs, s.base())
}

func (s *store) commit(parent int, ops [][]string) (int, commitInfo, error) {
	var info commitInfo
	if parent < -1 || parent >= len(s.parents) {
		return 0, info, fmt.Errorf("unknown parent %d", parent)
	}
	id := len(s.parents)
	lowers := []string{s.base()}
	if parent >= 0 {
		lowers = s.lowerdirs(parent)
	}
	for _, d := range []string{s.upper(id), s.work(id)} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return 0, info, err
		}
	}
	data := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s,%s", strings.Join(lowers, ":"), s.upper(id), s.work(id), overlayOpts)
	if err := syscall.Mount("overlay", s.mnt(), "overlay", 0, data); err != nil {
		return 0, info, fmt.Errorf("mount overlay: %w", err)
	}
	info.mountOptions = currentMountOptions(s.mnt())
	opErr := func() error {
		for _, op := range ops {
			n, err := applyOp(s.mnt(), op)
			if err != nil {
				return err
			}
			info.exdevRenames += n
		}
		return nil
	}()
	if err := syscall.Unmount(s.mnt(), 0); err != nil && opErr == nil {
		opErr = fmt.Errorf("unmount: %w", err)
	}
	if opErr != nil {
		_ = os.RemoveAll(s.upper(id))
		_ = os.RemoveAll(s.work(id))
		return 0, info, opErr
	}
	s.parents = append(s.parents, parent)
	return id, info, nil
}

func (s *store) view(id int) ([]string, error) {
	if id < 0 || id >= len(s.parents) {
		return nil, fmt.Errorf("unknown commit %d", id)
	}
	data := fmt.Sprintf("lowerdir=%s,%s", strings.Join(s.lowerdirs(id), ":"), overlayOpts)
	if err := syscall.Mount("overlay", s.mnt(), "overlay", syscall.MS_RDONLY, data); err != nil {
		return nil, fmt.Errorf("mount view: %w", err)
	}
	entries, err := dump(s.mnt())
	if uerr := syscall.Unmount(s.mnt(), 0); uerr != nil && err == nil {
		err = fmt.Errorf("unmount view: %w", uerr)
	}
	return entries, err
}

// safeJoin はシナリオの相対パスを mount 先の絶対パスにする。外へ出るパスは拒否する。
func safeJoin(root, rel string) (string, error) {
	if rel == "" || strings.HasPrefix(rel, "/") {
		return "", fmt.Errorf("bad path %q", rel)
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", fmt.Errorf("bad path %q", rel)
		}
	}
	return filepath.Join(root, filepath.FromSlash(rel)), nil
}

// applyOp は scripts/golden/overlayfs-scenarios.mjs の op を 1 つ当てる。
// 戻り値の int は、rename が EXDEV になってコピーで代わりにやった回数。
func applyOp(root string, op []string) (int, error) {
	if len(op) == 0 {
		return 0, errors.New("empty op")
	}
	want := map[string]int{"write": 3, "rm": 2, "rmdir": 2, "mkdir": 2, "mv": 3}[op[0]]
	if want == 0 || len(op) != want {
		return 0, fmt.Errorf("bad op %v", op)
	}
	a, err := safeJoin(root, op[1])
	if err != nil {
		return 0, err
	}
	switch op[0] {
	case "write":
		if err := os.MkdirAll(filepath.Dir(a), 0o755); err != nil {
			return 0, err
		}
		return 0, os.WriteFile(a, []byte(op[2]), 0o644)
	case "rm":
		return 0, syscall.Unlink(a)
	case "rmdir":
		return 0, os.RemoveAll(a)
	case "mkdir":
		return 0, os.MkdirAll(a, 0o755)
	case "mv":
		b, err := safeJoin(root, op[2])
		if err != nil {
			return 0, err
		}
		if err := os.MkdirAll(filepath.Dir(b), 0o755); err != nil {
			return 0, err
		}
		err = os.Rename(a, b)
		if errors.Is(err, syscall.EXDEV) {
			// redirect_dir=nofollow では、下の層にあるディレクトリの rename は EXDEV になる。
			// coreutils の mv と同じく、コピーして元を消す（record-kernel.mjs は mv を使っている）
			if err := copyTree(a, b); err != nil {
				return 0, err
			}
			return 1, os.RemoveAll(a)
		}
		return 0, err
	}
	return 0, nil
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		to := filepath.Join(dst, rel)
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(target, to)
		case d.IsDir():
			return os.MkdirAll(to, 0o755)
		default:
			in, err := os.Open(p)
			if err != nil {
				return err
			}
			defer in.Close()
			out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, in); err != nil {
				out.Close()
				return err
			}
			return out.Close()
		}
	})
}

// dump は record-kernel.mjs の dump と同じ形式でツリーを列挙する。
// 1 行 1 エントリ: 種別<TAB>パス[<TAB>詳細]。パスのバイト順（LC_ALL=C sort と同じ）。
func dump(root string) ([]string, error) {
	type entry struct{ path, line string }
	var entries []entry
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		var line string
		switch t := d.Type(); {
		case t&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			line = "l\t" + rel + "\t" + target
		case d.IsDir():
			line = "d\t" + rel
		case t.IsRegular():
			sum, err := sha256File(p)
			if err != nil {
				return err
			}
			line = "f\t" + rel + "\t" + sum
		default:
			line = "o\t" + rel
		}
		entries = append(entries, entry{rel, line})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })
	lines := make([]string, len(entries))
	for i, e := range entries {
		lines[i] = e.line
	}
	return lines, nil
}

func sha256File(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// currentMountOptions は /proc/mounts から mountpoint の overlay のオプションを、パスを除いて返す。
func currentMountOptions(mountpoint string) string {
	b, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 4 || f[1] != mountpoint || f[2] != "overlay" {
			continue
		}
		var keep []string
		for _, o := range strings.Split(f[3], ",") {
			if strings.HasPrefix(o, "lowerdir=") || strings.HasPrefix(o, "upperdir=") || strings.HasPrefix(o, "workdir=") {
				continue
			}
			keep = append(keep, o)
		}
		return strings.Join(keep, ",")
	}
	return ""
}
