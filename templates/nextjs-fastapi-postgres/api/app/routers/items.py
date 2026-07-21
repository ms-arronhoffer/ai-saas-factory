"""Items CRUD — the reference vertical slice. Ownership-scoped and validated."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_user
from ..models import Item, User
from ..schemas import ItemCreate, ItemRead, ItemUpdate

router = APIRouter(prefix="/api/items", tags=["items"])


@router.get("", response_model=list[ItemRead])
def list_items(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[Item]:
    return list(db.scalars(select(Item).where(Item.owner_id == user.id).order_by(Item.created_at.desc())))


@router.post("", response_model=ItemRead, status_code=status.HTTP_201_CREATED)
def create_item(payload: ItemCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Item:
    item = Item(title=payload.title, description=payload.description, owner_id=user.id)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def _get_owned(item_id: int, db: Session, user: User) -> Item:
    item = db.get(Item, item_id)
    if item is None or item.owner_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item not found")
    return item


@router.get("/{item_id}", response_model=ItemRead)
def get_item(item_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Item:
    return _get_owned(item_id, db, user)


@router.patch("/{item_id}", response_model=ItemRead)
def update_item(item_id: int, payload: ItemUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Item:
    item = _get_owned(item_id, db, user)
    if payload.title is not None:
        item.title = payload.title
    if payload.description is not None:
        item.description = payload.description
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_item(item_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> None:
    item = _get_owned(item_id, db, user)
    db.delete(item)
    db.commit()
