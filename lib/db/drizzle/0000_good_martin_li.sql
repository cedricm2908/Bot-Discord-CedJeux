CREATE TABLE "players" (
	"id" text PRIMARY KEY NOT NULL,
	"coins" integer DEFAULT 50 NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"xp" integer DEFAULT 0 NOT NULL,
	"irrigation_level" integer DEFAULT 0 NOT NULL,
	"fertilizer_level" integer DEFAULT 0 NOT NULL,
	"last_daily_at" timestamp with time zone,
	"auto_replant" boolean DEFAULT false NOT NULL,
	"weekly_snapshot_coins" integer DEFAULT 50 NOT NULL,
	"total_harvested" integer DEFAULT 0 NOT NULL,
	"quests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quests_reset_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plot_skin" text DEFAULT 'classic' NOT NULL,
	"unlocked_skins" text[] DEFAULT '{}'::text[] NOT NULL,
	"weather_forecast" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_coins_non_negative" CHECK ("players"."coins" >= 0),
	CONSTRAINT "players_xp_non_negative" CHECK ("players"."xp" >= 0),
	CONSTRAINT "players_level_positive" CHECK ("players"."level" >= 1),
	CONSTRAINT "players_irrigation_level_non_negative" CHECK ("players"."irrigation_level" >= 0),
	CONSTRAINT "players_fertilizer_level_non_negative" CHECK ("players"."fertilizer_level" >= 0),
	CONSTRAINT "players_total_harvested_non_negative" CHECK ("players"."total_harvested" >= 0),
	CONSTRAINT "players_weekly_snapshot_coins_non_negative" CHECK ("players"."weekly_snapshot_coins" >= 0)
);
--> statement-breakpoint
CREATE TABLE "plots" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"plot_index" integer NOT NULL,
	"crop_id" text,
	"planted_at" timestamp with time zone,
	"notified_ready" boolean DEFAULT false NOT NULL,
	CONSTRAINT "plots_player_id_plot_index_unique" UNIQUE("player_id","plot_index"),
	CONSTRAINT "plots_plot_index_non_negative" CHECK ("plots"."plot_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"item_id" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "inventory_items_player_id_item_id_unique" UNIQUE("player_id","item_id"),
	CONSTRAINT "inventory_items_quantity_non_negative" CHECK ("inventory_items"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "global_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"market_multiplier" double precision DEFAULT 1 NOT NULL,
	"previous_market_multiplier" double precision DEFAULT 1 NOT NULL,
	"market_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"weather" text DEFAULT 'normal' NOT NULL,
	"weather_multiplier" double precision DEFAULT 1 NOT NULL,
	"weather_changed_at" timestamp with time zone,
	"weather_expires_at" timestamp with time zone,
	"next_weather_at" timestamp with time zone NOT NULL,
	"next_weather_type" text DEFAULT 'rain' NOT NULL,
	"weekly_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_state_singleton" CHECK ("global_state"."id" = 1),
	CONSTRAINT "global_state_market_multiplier_range" CHECK ("global_state"."market_multiplier" >= 0.65 AND "global_state"."market_multiplier" <= 1.4),
	CONSTRAINT "global_state_weather_multiplier_positive" CHECK ("global_state"."weather_multiplier" > 0)
);
--> statement-breakpoint
CREATE TABLE "contract" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"crop_id" text NOT NULL,
	"required" integer NOT NULL,
	"remaining" integer NOT NULL,
	"bonus_multiplier" double precision NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_singleton" CHECK ("contract"."id" = 1),
	CONSTRAINT "contract_required_positive" CHECK ("contract"."required" > 0),
	CONSTRAINT "contract_remaining_non_negative" CHECK ("contract"."remaining" >= 0),
	CONSTRAINT "contract_remaining_le_required" CHECK ("contract"."remaining" <= "contract"."required"),
	CONSTRAINT "contract_bonus_multiplier_positive" CHECK ("contract"."bonus_multiplier" > 0)
);
--> statement-breakpoint
CREATE TABLE "reward_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"claim_type" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_claims_player_id_claim_type_unique" UNIQUE("player_id","claim_type")
);
--> statement-breakpoint
CREATE TABLE "daily_challenge" (
	"id" serial PRIMARY KEY NOT NULL,
	"crop_id" text NOT NULL,
	"target" integer NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"reward_coins" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"rewarded" boolean DEFAULT false NOT NULL,
	CONSTRAINT "daily_challenge_target_positive" CHECK ("daily_challenge"."target" > 0),
	CONSTRAINT "daily_challenge_progress_non_negative" CHECK ("daily_challenge"."progress" >= 0),
	CONSTRAINT "daily_challenge_reward_coins_non_negative" CHECK ("daily_challenge"."reward_coins" >= 0),
	CONSTRAINT "daily_challenge_rewarded_implies_completed" CHECK ("daily_challenge"."rewarded" = false OR "daily_challenge"."completed" = true)
);
--> statement-breakpoint
CREATE TABLE "daily_challenge_contributors" (
	"challenge_id" integer NOT NULL,
	"player_id" text NOT NULL,
	"contributed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_challenge_contributors_challenge_id_player_id_pk" PRIMARY KEY("challenge_id","player_id")
);
--> statement-breakpoint
ALTER TABLE "plots" ADD CONSTRAINT "plots_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reward_claims" ADD CONSTRAINT "reward_claims_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_challenge_contributors" ADD CONSTRAINT "daily_challenge_contributors_challenge_id_daily_challenge_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."daily_challenge"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_challenge_contributors" ADD CONSTRAINT "daily_challenge_contributors_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;