"""crew_requests table for tokenized crew accept/decline

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-06-22 13:00:00.000000

Adds the crew_requests table backing the crew-request feature: a producer
sends a crew member a request covering a set of schedule positions, and the
crew member accepts/declines from a tokenized public landing page
(#/crew/{token}). See backend/models.py CrewRequest for the full shape and
the position state machine it drives.

Additive + reversible. `token` is uniquely indexed (the public credential is
looked up by it on every /api/crew/{token} hit); project_id / contact_id /
sent_by_user_id are FK SET NULL so deleting a parent breaks the link without
destroying the request's audit trail.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd5e6f7a8b9c0'
down_revision: Union[str, None] = 'c4d5e6f7a8b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'crew_requests',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('token', sa.String(length=64), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=True),
        sa.Column('contact_id', sa.Integer(), nullable=True),
        sa.Column('position_ids', sa.JSON(), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=True),
        sa.Column('comment', sa.Text(), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
        sa.Column('responded_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('sent_by_user_id', sa.Integer(), nullable=True),
        sa.Column('respondent_ip', sa.String(length=64), nullable=True),
        sa.Column('respondent_ua', sa.String(length=300), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=True),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['contact_id'], ['contacts.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['sent_by_user_id'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('crew_requests', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_crew_requests_id'), ['id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crew_requests_token'), ['token'], unique=True)
        batch_op.create_index(batch_op.f('ix_crew_requests_project_id'), ['project_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crew_requests_contact_id'), ['contact_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_crew_requests_sent_by_user_id'), ['sent_by_user_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('crew_requests', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_crew_requests_sent_by_user_id'))
        batch_op.drop_index(batch_op.f('ix_crew_requests_contact_id'))
        batch_op.drop_index(batch_op.f('ix_crew_requests_project_id'))
        batch_op.drop_index(batch_op.f('ix_crew_requests_token'))
        batch_op.drop_index(batch_op.f('ix_crew_requests_id'))
    op.drop_table('crew_requests')
