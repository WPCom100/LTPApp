"""crew portal: crew_accounts, crew_sessions, crew_auth_tokens

Revision ID: e0f1a2b3c4d5
Revises: d9e0f1a2b3c4
Create Date: 2026-09-12 14:00:00.000000

Backs the crew member's own sign-in to the crew portal (#/crew-portal): the
password account (one per roster contact), its login sessions (the
`ltp_crew_session` cookie, stored hashed like staff sessions), and the
one-time invitation / password-reset links (stored hashed, single-use,
expiring). See backend/models.py CrewAccount / CrewSession / CrewAuthToken and
backend/crew_auth.py.

Entirely additive: no existing table or column changes. Reversible. Each
create is guarded on the inspector so a database that already carries a table
(a partially-applied deploy) heals to head instead of crash-looping on
"table already exists".

Chained behind the cross-rentals revision (d9e0f1a2b3c4): the two features were
built side by side off the same parent and had picked the same next id, which
Alembic would have refused as a duplicate revision. Nothing here reads or
writes the cross-rental tables — the ordering is the chain, not a dependency.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e0f1a2b3c4d5'
down_revision: Union[str, None] = 'd9e0f1a2b3c4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _tables() -> set:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    existing = _tables()
    if "crew_accounts" not in existing:
        op.create_table(
            'crew_accounts',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('contact_id', sa.Integer(), nullable=False),
            sa.Column('email', sa.String(length=255), nullable=False),
            sa.Column('password_hash', sa.Text(), nullable=False, server_default=""),
            sa.Column('disabled', sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column('failed_attempts', sa.Integer(), nullable=False, server_default="0"),
            sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True),
            sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('password_changed_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
            sa.ForeignKeyConstraint(['contact_id'], ['contacts.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
        )
        with op.batch_alter_table('crew_accounts', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_crew_accounts_id'), ['id'], unique=False)
            batch_op.create_index(batch_op.f('ix_crew_accounts_contact_id'), ['contact_id'], unique=True)
            batch_op.create_index(batch_op.f('ix_crew_accounts_email'), ['email'], unique=True)

    if "crew_sessions" not in existing:
        op.create_table(
            'crew_sessions',
            sa.Column('id', sa.String(length=64), nullable=False),
            sa.Column('account_id', sa.Integer(), nullable=False),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
            sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(['account_id'], ['crew_accounts.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
        )
        with op.batch_alter_table('crew_sessions', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_crew_sessions_account_id'), ['account_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_crew_sessions_expires_at'), ['expires_at'], unique=False)

    if "crew_auth_tokens" not in existing:
        op.create_table(
            'crew_auth_tokens',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('contact_id', sa.Integer(), nullable=False),
            sa.Column('kind', sa.String(length=10), nullable=False),
            sa.Column('token_hash', sa.String(length=64), nullable=False),
            sa.Column('email', sa.String(length=255), nullable=False, server_default=""),
            sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
            sa.Column('created_by_user_id', sa.Integer(), nullable=True),
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
            sa.ForeignKeyConstraint(['contact_id'], ['contacts.id'], ondelete='CASCADE'),
            sa.ForeignKeyConstraint(['created_by_user_id'], ['users.id'], ondelete='SET NULL'),
            sa.PrimaryKeyConstraint('id'),
        )
        with op.batch_alter_table('crew_auth_tokens', schema=None) as batch_op:
            batch_op.create_index(batch_op.f('ix_crew_auth_tokens_id'), ['id'], unique=False)
            batch_op.create_index(batch_op.f('ix_crew_auth_tokens_contact_id'), ['contact_id'], unique=False)
            batch_op.create_index(batch_op.f('ix_crew_auth_tokens_token_hash'), ['token_hash'], unique=True)
            batch_op.create_index(batch_op.f('ix_crew_auth_tokens_expires_at'), ['expires_at'], unique=False)


def downgrade() -> None:
    existing = _tables()
    for name in ("crew_auth_tokens", "crew_sessions", "crew_accounts"):
        if name in existing:
            op.drop_table(name)
