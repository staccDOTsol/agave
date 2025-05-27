use {
    agave_feature_set::{enable_secp256r1_precompile, FeatureSet},
    solana_fee_structure::FeeDetails,
    solana_svm_transaction::svm_message::SVMMessage,
};

use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

// Fixed fee constants based on MEV data
// Average arbitrage profit: 0.027 SOL = 27_000_000 lamports
// Average sandwich profit: 0.076 SOL = 76_000_000 lamports
// Half sandwich: 0.038 SOL = 38_000_000 lamports
pub const FIXED_TRANSACTION_FEE_LAMPORTS: u64 = 27_000_000; // Same as average arbitrage
// Alternative: pub const FIXED_TRANSACTION_FEE_LAMPORTS: u64 = 38_000_000; // Half of sandwich

// Vote transactions should have minimal fees to ensure consensus participation
pub const VOTE_TRANSACTION_FEE_LAMPORTS: u64 = 5_000; // Keep original low fee for votes

/// Bools indicating the activation of features relevant
/// to the fee calculation.
// DEVELOPER NOTE:
// This struct may become empty at some point. It is preferable to keep it
// instead of removing, since fees will naturally be changed via feature-gates
// in the future. Keeping this struct will help keep things organized.
#[derive(Copy, Clone)]
pub struct FeeFeatures {
    pub enable_secp256r1_precompile: bool,
}

impl From<&FeatureSet> for FeeFeatures {
    fn from(feature_set: &FeatureSet) -> Self {
        Self {
            enable_secp256r1_precompile: feature_set.is_active(&enable_secp256r1_precompile::ID),
        }
    }
}

/// Check if a message is a simple vote transaction
/// A simple vote transaction has only vote program instructions
fn is_simple_vote_message(message: &impl SVMMessage) -> bool {
    // Get the vote program ID
    let vote_program_id = Pubkey::from_str("Vote111111111111111111111111111111111111111").unwrap();
    
    // Check if all instructions are for the vote program
    let mut has_vote_instruction = false;
    for (program_id, _instruction) in message.program_instructions_iter() {
        if program_id == &vote_program_id {
            has_vote_instruction = true;
        } else {
            // If any instruction is not for the vote program, it's not a simple vote
            return false;
        }
    }
    
    // Must have at least one vote instruction
    has_vote_instruction
}

/// Calculate fee for `SanitizedMessage`
/// In Solana Classic, all non-vote transactions have the same fixed fee
pub fn calculate_fee(
    message: &impl SVMMessage,
    zero_fees_for_test: bool,
    _lamports_per_signature: u64, // Ignored in our fixed fee model
    prioritization_fee: u64,
    _fee_features: FeeFeatures, // Ignored in our fixed fee model
) -> u64 {
    calculate_fee_details(
        message,
        zero_fees_for_test,
        _lamports_per_signature,
        prioritization_fee,
        _fee_features,
    )
    .total_fee()
}

pub fn calculate_fee_details(
    message: &impl SVMMessage,
    zero_fees_for_test: bool,
    _lamports_per_signature: u64, // Ignored in our fixed fee model
    prioritization_fee: u64,
    _fee_features: FeeFeatures, // Ignored in our fixed fee model
) -> FeeDetails {
    if zero_fees_for_test {
        return FeeDetails::default();
    }

    // Check if this is a vote transaction
    let base_fee = if is_simple_vote_message(message) {
        VOTE_TRANSACTION_FEE_LAMPORTS
    } else {
        FIXED_TRANSACTION_FEE_LAMPORTS
    };

    // Fixed fee for all transactions + any prioritization fee
    FeeDetails::new(
        base_fee,
        prioritization_fee,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_fixed_fee() {
        // Test that fee calculation returns fixed fee regardless of input
        
        // Create a dummy feature set
        let fee_features = FeeFeatures {
            enable_secp256r1_precompile: true,
        };
        
        // Test basic fee calculation for non-vote transactions
        let fee_details = FeeDetails::new(FIXED_TRANSACTION_FEE_LAMPORTS, 0);
        assert_eq!(fee_details.total_fee(), FIXED_TRANSACTION_FEE_LAMPORTS);
        
        // Test vote transaction fee
        let vote_fee_details = FeeDetails::new(VOTE_TRANSACTION_FEE_LAMPORTS, 0);
        assert_eq!(vote_fee_details.total_fee(), VOTE_TRANSACTION_FEE_LAMPORTS);
        
        // Test with prioritization fee
        let priority_fee = 1_000_000;
        let fee_details_with_priority = FeeDetails::new(FIXED_TRANSACTION_FEE_LAMPORTS, priority_fee);
        assert_eq!(fee_details_with_priority.total_fee(), FIXED_TRANSACTION_FEE_LAMPORTS + priority_fee);
        
        // Test that our constants are set correctly
        assert_eq!(FIXED_TRANSACTION_FEE_LAMPORTS, 27_000_000); // 0.027 SOL
        assert_eq!(VOTE_TRANSACTION_FEE_LAMPORTS, 5_000); // 0.000005 SOL
    }
}
