use solana_fee_calculator::FeeRateGovernor;
use solana_rent::Rent;

/// Solana Classic default genesis parameters
pub struct SolanaClassicDefaults;

impl SolanaClassicDefaults {
    /// Fixed fee model - no dynamic fee adjustment
    pub fn fee_rate_governor() -> FeeRateGovernor {
        FeeRateGovernor {
            // These values are ignored in our fixed fee model but kept for compatibility
            target_lamports_per_signature: 27_000_000, // 0.027 SOL
            target_signatures_per_slot: 0, // Disable signature-based fee adjustments
            min_lamports_per_signature: 27_000_000,
            max_lamports_per_signature: 27_000_000,
            burn_percent: 50, // Keep 50% burn rate
        }
    }
    
    /// Rent configuration - same as mainnet
    pub fn rent() -> Rent {
        Rent::default()
    }
    
    /// Inflation - disabled by default for Solana Classic
    pub fn inflation() -> solana_inflation::Inflation {
        solana_inflation::Inflation::new_disabled()
    }
} 