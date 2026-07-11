-- SSH host-key pinning (security review G7).
--
-- sshExec historically accepted ANY host key (TOFU-ish, ssh2's default).
-- We now pin: the SHA-256 fingerprint of the box's host key is captured on
-- the first successful connection after a (re)provision and every later
-- connection verifies strictly against it, closing the connect-time MITM
-- window for the fleet's routine SSH (deploys, backups, wipes, probes).
--
-- The pin lives on the vps_ssh_keys row, so flows that mint/rotate a row
-- (fresh provisions, OVH rebuilds, adopts) naturally start unpinned and
-- re-capture — no stale-pin lockouts after a box is re-imaged.

alter table public.vps_ssh_keys
  add column if not exists host_key_fingerprint text;

comment on column public.vps_ssh_keys.host_key_fingerprint is
  'SHA256:<base64> fingerprint of the box''s SSH host key, captured on first connect (TOFU at provision) and verified strictly afterwards. NULL = not yet captured. Cleared on adopt/recreate and BYOS host changes (host keys regenerate).';
