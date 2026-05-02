//! Merkle tree construction for the claimable partition.
//!
//! Genesis embeds a single root hash; the lazy-claim program verifies inclusion proofs
//! against it. Leaves are sorted by pubkey ascending for determinism — any genesis builder
//! reading the same snapshot produces the same root byte-for-byte.
//!
//! Hash function: `solana_program::hash::hashv` (SHA-256). Domain separation byte `0x00`
//! for leaves and `0x01` for internal nodes prevents second-preimage attacks where a leaf
//! could be misinterpreted as a node hash or vice versa.
//!
//! Odd-leaf handling: the last hash in a layer of odd length is duplicated to itself when
//! computing the next layer up — standard pattern.

use serde::{Deserialize, Serialize};
use solana_program::hash::{hashv, Hash};
use solana_program::pubkey::Pubkey;

/// Domain-separation byte prepended to leaf preimages before hashing.
/// Public so downstream crates (lazy-claim program, claim-cli) can hash leaves identically
/// without redeclaring the constant.
pub const LEAF_DOMAIN: u8 = 0x00;
/// Domain-separation byte prepended to internal node preimages before hashing.
/// Public for the same reason as [`LEAF_DOMAIN`].
pub const NODE_DOMAIN: u8 = 0x01;

/// A single claimable account from the snapshot.
///
/// Owner is implicitly the System program and `data_len` is implicitly zero — both are
/// invariants of the partition rule, so the leaf only commits to pubkey + lamports.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimableLeaf {
    pub pubkey: Pubkey,
    pub lamports: u64,
}

impl ClaimableLeaf {
    pub fn hash(&self) -> Hash {
        hashv(&[
            &[LEAF_DOMAIN],
            self.pubkey.as_ref(),
            &self.lamports.to_le_bytes(),
        ])
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MerkleRoot(pub Hash);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MerkleTree {
    pub root: MerkleRoot,
    pub leaf_count: usize,
}

impl MerkleTree {
    /// Build a Merkle tree from leaves. Sorts by pubkey ascending for determinism.
    pub fn build(mut leaves: Vec<ClaimableLeaf>) -> Self {
        if leaves.is_empty() {
            return Self {
                root: MerkleRoot(Hash::default()),
                leaf_count: 0,
            };
        }

        leaves.sort_by(|a, b| a.pubkey.cmp(&b.pubkey));
        let leaf_count = leaves.len();

        let mut layer: Vec<Hash> = leaves.iter().map(ClaimableLeaf::hash).collect();

        while layer.len() > 1 {
            let mut next_layer: Vec<Hash> = Vec::with_capacity(layer.len() / 2 + 1);
            for chunk in layer.chunks(2) {
                let combined = if chunk.len() == 2 {
                    hashv(&[&[NODE_DOMAIN], chunk[0].as_ref(), chunk[1].as_ref()])
                } else {
                    // Odd-leaf duplication.
                    hashv(&[&[NODE_DOMAIN], chunk[0].as_ref(), chunk[0].as_ref()])
                };
                next_layer.push(combined);
            }
            layer = next_layer;
        }

        Self {
            root: MerkleRoot(layer[0]),
            leaf_count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    fn leaf(byte: u8, lamports: u64) -> ClaimableLeaf {
        ClaimableLeaf {
            pubkey: pk(byte),
            lamports,
        }
    }

    #[test]
    fn empty_tree_has_default_root() {
        let tree = MerkleTree::build(vec![]);
        assert_eq!(tree.root, MerkleRoot(Hash::default()));
        assert_eq!(tree.leaf_count, 0);
    }

    #[test]
    fn single_leaf_root_is_leaf_hash() {
        let l = leaf(1, 1_000);
        let tree = MerkleTree::build(vec![l.clone()]);
        assert_eq!(tree.root.0, l.hash());
        assert_eq!(tree.leaf_count, 1);
    }

    #[test]
    fn determinism_under_input_reordering() {
        let leaves_a = vec![leaf(1, 100), leaf(2, 200), leaf(3, 300), leaf(4, 400)];
        let leaves_b = vec![leaf(4, 400), leaf(2, 200), leaf(1, 100), leaf(3, 300)];

        let tree_a = MerkleTree::build(leaves_a);
        let tree_b = MerkleTree::build(leaves_b);

        assert_eq!(tree_a.root, tree_b.root);
        assert_eq!(tree_a.leaf_count, tree_b.leaf_count);
    }

    #[test]
    fn odd_leaf_count_is_handled() {
        // 3 leaves: layer 1 = [h1, h2, h3], layer 2 = [hash(h1,h2), hash(h3,h3)],
        // root = hash(layer2[0], layer2[1]).
        let leaves = vec![leaf(1, 100), leaf(2, 200), leaf(3, 300)];
        let tree = MerkleTree::build(leaves);
        assert_eq!(tree.leaf_count, 3);
        assert_ne!(tree.root, MerkleRoot(Hash::default()));
    }

    #[test]
    fn different_lamports_change_root() {
        let tree_a = MerkleTree::build(vec![leaf(1, 100), leaf(2, 200)]);
        let tree_b = MerkleTree::build(vec![leaf(1, 100), leaf(2, 201)]);
        assert_ne!(tree_a.root, tree_b.root);
    }

    #[test]
    fn different_pubkeys_change_root() {
        let tree_a = MerkleTree::build(vec![leaf(1, 100), leaf(2, 200)]);
        let tree_b = MerkleTree::build(vec![leaf(1, 100), leaf(3, 200)]);
        assert_ne!(tree_a.root, tree_b.root);
    }
}
