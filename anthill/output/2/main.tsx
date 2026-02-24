import React, { useState, useEffect } from "react";

export default function PlanForm() {
  const [planName, setPlanName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<number | null>(null);
  const [editingPlan, setEditingPlan] = useState<any>(null);
  const [modalOpen, setModalOpen] => useState(false);
  const [modalStepIndex, setModalStepIndex] = useState<number | null>(null);
  const navigate = useNavigate();

  const handleStepChange = (index: number, action: 'add' | 'remove') => {
    if (action === 'add') {
      setSteps(prevSteps => [...prevSteps, '']);
    } else if (action === 'remove') {
      if (steps.length > 0) {
        setSteps(prevSteps => prevSteps.filter((_, i) => i !== index));
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch('/api/plans', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: planName,
          description: description,
          steps: steps,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to create plan');
      }

      const data = await response.json();
      navigate('/plans');
    } catch (err) {
      setError('Failed to create plan. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleEditPlan = async (planId: number) => {
    setEditingPlanId(planId);
    try {
      const response = await fetch(`/api/plans/${planId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch plan');
      }

      const data = await response.json();
      setEditingPlan(data);
      setModalOpen(true);
    } catch (err) {
      setError('Failed to load plan. Please try again.');
    }
  };

  const handleSavePlan = async () => {
    if (!editingPlanId) return;
    try {
      const response = await fetch(`/api/plans/${editingPlanId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: editingPlan.name,
          description: editingPlan.description,
          steps: editingPlan.steps,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update plan');
      }

      const data = await response.json();
      setEditingPlanId(null);
      setEditingPlan(null);
      setModalOpen(false);
      navigate('/plans');
    } catch (err) {
      setError('Failed to update plan. Please try again.');
    }
  };

  return (
    <div className="container" style={{ padding: '20px' }}>
      <h1>Create a new plan</h1>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: '10px' }}>
          <label htmlFor="planName" style={{ marginRight: '5px' }}>Plan Name:</label>
          <input
            type="text"
            id="planName"
            value={planName}
            onChange={(e) => setPlanName(e.target.value)}
            style={{ padding: '5px' }}
          />
        </div>
        <div style={{ marginBottom: '10px' }}>
          <label htmlFor="description" style={{ marginRight: '5px' }}>Description:</label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ padding: '5px', width: '100%' }}
          />
        </div>
        <div style={{ marginBottom: '10px' }}>
          <label htmlFor="steps" style={{ marginRight: '5px' }}>Steps:</label>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {steps.map((step, index) => (
              <div key={index} style={{ display: 'flex', alignItems: 'center', marginBottom: '5px' }}>
                <input
                  type="text"
                  value={step}
                  onChange={(e) => {
                    const newSteps = [...steps];
                    newSteps[index] = e.target.value;
                    setSteps(newSteps);
                  }}
                  style={{ flex: 1, padding: '5px' }}
                />
                <button
                  type="button"
                  onClick={() => handleStepChange(index, 'remove')}
                  style={{ marginLeft: '5px', padding: '3px 5px' }}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => handleStepChange(steps.length, 'add')}
              style={{ padding: '5px', marginLeft: '5px' }}
            >
              Add Step
            </button>
          </div>
        </div>
        <button
          type="submit"
          style={{ padding: '10px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px' }}
        >
          {loading ? 'Creating...' : 'Create Plan'}
        </button>
      </form>
    </div>
  );
}