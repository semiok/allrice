/* P02 synthetic probes only. Not a production command runner or sandbox API. */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static int denied(void) {
  int saved = errno;
  printf("denied errno=%d\n", saved);
  return saved == EPERM || saved == EACCES ? 0 : 1;
}

static void limit(int name, rlim_t soft, rlim_t hard) {
  struct rlimit value = {soft, hard};
  if (setrlimit(name, &value) != 0) { perror("setrlimit"); exit(90); }
}

static int write_file(const char *path, const char *value) {
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return -1;
  ssize_t n = write(fd, value, strlen(value));
  int saved = errno;
  close(fd);
  errno = saved;
  return n == (ssize_t)strlen(value) ? 0 : -1;
}

int main(int argc, char **argv) {
  setbuf(stdout, NULL);
  setbuf(stderr, NULL);
  alarm(5); /* Every probe and descendant has a small independent wall bound. */
  if (argc < 2) return 90;
  const char *mode = argv[1];

  /* Trusted launcher applies hard limits BEFORE exec of the fixed probe binary.
     No arbitrary executable or shell input. Limits remain after exec/fork. */
  if (!strcmp(mode, "limited")) {
    if (argc < 3) return 90;
    limit(RLIMIT_CORE, 0, 0);
    limit(RLIMIT_CPU, 1, 2);
    limit(RLIMIT_NOFILE, 32, 32);
    limit(RLIMIT_FSIZE, 65536, 65536);
    execv(argv[0], argv + 1);
    perror("exec limited probe");
    return 90;
  }
  if (!strcmp(mode, "hello")) { puts("probe-started"); return 0; }
  if (!strcmp(mode, "rw") && argc == 3) {
    if (write_file(argv[2], "synthetic-workspace\n")) return 1;
    char buf[64] = {0};
    int fd = open(argv[2], O_RDONLY);
    if (fd < 0) return 1;
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n < 0 || strcmp(buf, "synthetic-workspace\n")) return 1;
    puts("workspace-rw"); return 0;
  }
  if (!strcmp(mode, "read-denied") && argc == 3) {
    int fd = open(argv[2], O_RDONLY);
    if (fd < 0) return denied();
    close(fd); puts("unexpected-readable"); return 1;
  }
  if (!strcmp(mode, "write-denied") && argc == 3) {
    if (write_file(argv[2], "unexpected-write\n")) return denied();
    puts("unexpected-writable"); return 1;
  }
  if (!strcmp(mode, "rename-denied") && argc == 4) {
    if (rename(argv[2], argv[3])) return denied();
    puts("unexpected-rename"); return 1;
  }
  if (!strcmp(mode, "link-denied") && argc == 4) {
    if (link(argv[2], argv[3])) return denied();
    puts("unexpected-hardlink"); return 1;
  }
  if (!strcmp(mode, "env")) {
    if (getenv("ALLRICE_P02_PARENT_CANARY") || getenv("SSH_AUTH_SOCK") ||
        getenv("DYLD_INSERT_LIBRARIES") || getenv("NODE_OPTIONS")) return 1;
    puts("environment-filtered"); return 0;
  }
  if ((!strcmp(mode, "tcp") || !strcmp(mode, "udp")) && argc == 3) {
    int type = !strcmp(mode, "tcp") ? SOCK_STREAM : SOCK_DGRAM;
    int fd = socket(AF_INET, type, 0);
    if (fd < 0) return denied();
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET; addr.sin_port = htons((uint16_t)atoi(argv[2]));
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    int rc = type == SOCK_STREAM
      ? connect(fd, (struct sockaddr *)&addr, sizeof(addr))
      : (int)sendto(fd, "synthetic", 9, 0, (struct sockaddr *)&addr, sizeof(addr));
    int saved = errno; close(fd); errno = saved;
    if (rc < 0) return denied();
    puts("network-reached"); return 0;
  }
  if (!strcmp(mode, "bind")) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return denied();
    struct sockaddr_in addr = {0}; addr.sin_family = AF_INET;
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
    int rc = bind(fd, (struct sockaddr *)&addr, sizeof(addr));
    int saved = errno; close(fd); errno = saved;
    if (rc < 0) return denied();
    puts("unexpected-bound"); return 1;
  }
  if (!strcmp(mode, "unix") && argc == 3) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return denied();
    struct sockaddr_un addr = {0}; addr.sun_family = AF_UNIX;
    if (strlen(argv[2]) >= sizeof(addr.sun_path)) { close(fd); return 90; }
    strcpy(addr.sun_path, argv[2]);
    int rc = connect(fd, (struct sockaddr *)&addr, sizeof(addr));
    int saved = errno; close(fd); errno = saved;
    if (rc < 0) return denied();
    puts("network-reached"); return 0;
  }
  if (!strcmp(mode, "fork-denied")) {
    pid_t pid = fork();
    if (pid < 0) return denied();
    if (!pid) _exit(0);
    waitpid(pid, NULL, 0); puts("unexpected-fork"); return 1;
  }
  if (!strcmp(mode, "inherit") && argc == 4) {
    pid_t pid = fork();
    if (pid < 0) return 1;
    if (!pid) {
      alarm(4);
      execl(argv[2], argv[2], "read-denied", argv[3], (char *)NULL);
      _exit(91);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) return 1;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
  }
  if (!strcmp(mode, "exec-denied") && argc == 3) {
    execl(argv[2], argv[2], "hello", (char *)NULL);
    return denied();
  }
  if (!strcmp(mode, "fds") && argc == 3) {
    int fds[64], count = 0;
    while (count < 64) {
      int fd = open(argv[2], O_RDONLY);
      if (fd < 0) break;
      fds[count++] = fd;
    }
    int saved = errno;
    for (int i = 0; i < count; i++) close(fds[i]);
    printf("fds=%d errno=%d\n", count, saved);
    return count < 32 && saved == EMFILE ? 0 : 1;
  }
  if (!strcmp(mode, "file-size") && argc == 3) {
    signal(SIGXFSZ, SIG_IGN);
    int fd = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return 1;
    char bytes[4096] = {0}; size_t total = 0;
    for (int i = 0; i < 32; i++) {
      ssize_t n = write(fd, bytes, sizeof(bytes));
      if (n < 0) break;
      total += (size_t)n;
    }
    int saved = errno; close(fd);
    printf("file-bytes=%zu errno=%d\n", total, saved);
    return total == 65536 && saved == EFBIG ? 0 : 1;
  }
  if (!strcmp(mode, "cpu") || !strcmp(mode, "cpu-hard")) {
    int ignores = !strcmp(mode, "cpu-hard");
    if (ignores) signal(SIGXCPU, SIG_IGN);
    volatile unsigned long value = 1;
    unsigned int steps = 0;
    for (;;) {
      value = value * 33 + 1;
      if (ignores && ++steps == 1000000) {
        struct rusage usage; steps = 0;
        if (getrusage(RUSAGE_SELF, &usage)) return 90;
        long micros = usage.ru_utime.tv_sec * 1000000 + usage.ru_utime.tv_usec
          + usage.ru_stime.tv_sec * 1000000 + usage.ru_stime.tv_usec;
        if (micros >= 2500000) {
          printf("survived-hard-limit cpu-us=%ld\n", micros); return 0;
        }
      }
    } /* <=2.5 CPU seconds for hard-limit observation; alarm + outer watchdog. */
  }
  if (!strcmp(mode, "wall")) { sleep(3); return 1; }
  if (!strcmp(mode, "output")) {
    char bytes[1024]; memset(bytes, 'x', sizeof(bytes));
    for (int i = 0; i < 64; i++) {
      if (write(i % 2 ? STDERR_FILENO : STDOUT_FILENO, bytes, sizeof(bytes)) < 0) break;
      usleep(1000);
    }
    return 0;
  }
  if (!strcmp(mode, "memory-gap")) {
    /* Bounded 16 MiB, never stress/OOM host. DATA is not total mapped memory. */
    struct rlimit requested = {8 * 1024 * 1024, 8 * 1024 * 1024};
    int accepted = setrlimit(RLIMIT_DATA, &requested) == 0;
    if (!accepted) printf("8MiB-DATA-limit-rejected errno=%d\n", errno);
    size_t size = 16 * 1024 * 1024;
    void *data = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (data == MAP_FAILED) { printf("mmap-denied errno=%d\n", errno); return 0; }
    memset(data, 1, size); munmap(data, size);
    puts(accepted ? "mapped-16MiB-despite-8MiB-DATA" : "mapped-16MiB-without-requested-DATA-limit");
    return 0;
  }
  if (!strcmp(mode, "process-group-gap") && argc == 4) {
    pid_t pid = fork();
    if (pid < 0) return 1;
    if (!pid) {
      alarm(3);
      if (setsid() < 0) _exit(1);
      close(STDIN_FILENO); close(STDOUT_FILENO); close(STDERR_FILENO);
      for (int i = 0; i < 12; i++) {
        if (write_file(argv[2], "bounded-descendant-alive\n")) _exit(1);
        usleep(100000);
      }
      write_file(argv[3], "bounded-descendant-finished\n");
      _exit(0);
    }
    puts("one-bounded-descendant-started");
    sleep(3); waitpid(pid, NULL, 0); return 1;
  }
  fputs("Unknown synthetic probe mode or wrong arguments\n", stderr);
  return 90;
}
