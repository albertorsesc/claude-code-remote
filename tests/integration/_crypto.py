"""Python counterpart to packages/protocol/src/crypto.ts, byte-compatible (verified interop: X25519
DER key exchange, HKDF-SHA256, AES-256-GCM with the project's separate-tag + `direction:seq`-as-AAD
convention, the direction binding stops a daemon->client frame authenticating if reflected back).
Lets integration tests speak the daemon's real authenticated, encrypted protocol instead of a
plaintext shortcut."""
import base64
import hashlib
import hmac
import json

from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives import serialization, hashes

INFO = b'app.claudecode/v1'


def generate_identity():
    priv = X25519PrivateKey.generate()
    return priv, priv.public_key()


def export_public_der_b64(pub: X25519PublicKey) -> str:
    return base64.b64encode(pub.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )).decode()


def import_public_der_b64(b64: str) -> X25519PublicKey:
    return serialization.load_der_public_key(base64.b64decode(b64))


def derive_session_key(private_key: X25519PrivateKey, peer_public_key: X25519PublicKey, salt: bytes) -> bytes:
    shared = private_key.exchange(peer_public_key)
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=INFO).derive(shared)


def seal(key: bytes, seq: int, plaintext: dict, direction: str = 'c2d') -> dict:
    """Direction defaults to 'c2d' (client->daemon): every integration caller is a test CLIENT
    sending commands, so the default matches. The daemon/CLI (crypto.ts) require the direction
    explicitly. AAD = f'{direction}:{seq}', byte-identical to crypto.ts's frameAAD()."""
    import os
    nonce = os.urandom(12)
    aad = f'{direction}:{seq}'.encode('utf-8')
    ct_and_tag = AESGCM(key).encrypt(nonce, json.dumps(plaintext).encode('utf-8'), aad)
    ciphertext, tag = ct_and_tag[:-16], ct_and_tag[-16:]
    return {
        'n': base64.b64encode(nonce).decode(),
        'c': base64.b64encode(ciphertext).decode(),
        't': base64.b64encode(tag).decode(),
        'seq': seq,
    }


def open_frame(key: bytes, frame: dict, direction: str = 'd2c') -> dict:
    """Raises on tampered/undecryptable/wrong-direction frames, same contract as crypto.ts's open().
    Direction defaults to 'd2c' (daemon->client): every integration caller reads daemon events."""
    nonce = base64.b64decode(frame['n'])
    ciphertext = base64.b64decode(frame['c'])
    tag = base64.b64decode(frame['t'])
    aad = f'{direction}:{frame["seq"]}'.encode('utf-8')
    plain = AESGCM(key).decrypt(nonce, ciphertext + tag, aad)
    return json.loads(plain)


def pairing_proof(secret: str, device_public_key_b64: str, daemon_public_key_b64: str) -> str:
    """Matches pairingProof in @claude-code-remote/protocol exactly."""
    mac = hmac.new(secret.encode('utf-8'), (device_public_key_b64 + daemon_public_key_b64).encode('utf-8'), hashlib.sha256)
    return base64.b64encode(mac.digest()).decode()
